import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import cookie from 'cookie';
import { isUuid, normalizeUuid } from '../../common/crypto';
import { Prisma } from '../../../generated/prisma/client';
import {
  AccountLifecycleBus,
  type AccountLifecycleSignal,
} from '../../common/auth/account-lifecycle.bus';
import { SessionService } from '../../common/auth/session.service';
import { DomainError } from '../../common/errors';
import { SESSION_COOKIE_NAME } from '../../common/security';
import { errorType } from '../../common/observability';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeRedisService } from './realtime-redis.service';
import {
  LiveSessionService,
  toLiveSessionDto,
} from '../live-sessions/application/live-session.service';
import type { SessionQuestionResultsDto } from '../live-sessions/api/dto';
import {
  isJoinableLiveSessionStatus,
  SessionQuestionStatus,
} from '../live-sessions/domain';
import { AccountRole } from '../identity/domain/roles';
import { ParticipantService } from '../participants/application/participant.service';
import {
  assessReplay,
  parseLastEventSeq,
  RealtimeEvent,
  RealtimeSyncReason,
  RealtimeVisibility,
  toEventSeqWire,
  type RealtimeEventEnvelope,
  type RealtimeEventName,
  type RealtimeReplayRow,
} from './live-session-realtime-contract';

/**
 * Durable Socket.IO gateway (namespace `/live`).
 *
 * Handshake authentication reuses the existing Web session cookie (teacher) and
 * participant token + session code (participant) paths. PostgreSQL remains the
 * sole authority: the outbox supplies ordered delivery/replay evidence while
 * actor-specific snapshots and result projections are re-read from PostgreSQL.
 * The in-process event bus is consumed by the bounded publisher only as a
 * post-commit wake hint; it is not an event source.
 */

const LIVE_NAMESPACE = 'live';
const REPLAY_LIMIT = 500;
const ACCOUNT_REVOCATION_RETRY_INITIAL_MS = 1_000;
const ACCOUNT_REVOCATION_RETRY_MAX_MS = 30_000;

type DurableRealtimeEvent = Prisma.LiveSessionEventGetPayload<object>;

type SnapshotDeliveryOptions = {
  eventSeq?: string;
  aggregateVersion?: number;
  reason?: string;
  serverTimestamp?: string;
};

function sessionRoom(liveSessionId: string): string {
  return `session:${liveSessionId}`;
}
function teacherRoom(liveSessionId: string): string {
  return `teacher:${liveSessionId}`;
}

function toParticipantLiveSessionDto(
  view: Awaited<ReturnType<LiveSessionService['getParticipantSnapshot']>>,
) {
  const snapshot = toLiveSessionDto(view.session);
  const {
    questionSelections: _questionSelections,
    sessionQuestions,
    ...participantSnapshot
  } = snapshot;
  return {
    ...participantSnapshot,
    sessionQuestions: (sessionQuestions ?? [])
      .filter((question) => question.status === SessionQuestionStatus.OPEN)
      .map((question) => ({
        ...question,
        hasSubmitted: view.submittedQuestionIds.has(question.id),
      })),
  };
}

type AuthenticatedClient =
  | {
      kind: 'teacher';
      accountId: string;
      role: string;
      liveSessionId: string;
    }
  | {
      kind: 'participant';
      participantId: string;
      liveSessionId: string;
      accountId?: string;
    };

type DisconnectableSocket = {
  id: string;
  disconnect(close?: boolean): unknown;
};

@WebSocketGateway({ namespace: LIVE_NAMESPACE })
export class LiveGateway
  implements
    OnModuleInit,
    OnModuleDestroy,
    OnGatewayConnection,
    OnGatewayDisconnect
{
  private readonly logger = new Logger(LiveGateway.name);
  /** Serialize every outbound operation per Socket.IO id. */
  private readonly deliveryQueues = new Map<string, Promise<void>>();
  private accountLifecycleUnsubscribe?: () => void;

  @WebSocketServer()
  server!: Server;

  private readonly pendingDisabledAccounts = new Map<string, number>();
  private readonly disabledAccountRetryTimers = new Map<
    string,
    NodeJS.Timeout
  >();
  private shuttingDown = false;

  constructor(
    private readonly sessions: SessionService,
    private readonly liveSessions: LiveSessionService,
    private readonly participants: ParticipantService,
    private readonly prisma: PrismaService,
    private readonly redis: RealtimeRedisService,
    private readonly accountLifecycleBus: AccountLifecycleBus,
  ) {}

  onModuleInit(): void {
    // US-F8: account-level lifecycle signals (e.g. a disabled account) are on
    // a separate boundary. Disconnect the affected teacher/admin and
    // account-bound participant sockets immediately; anonymous participant
    // sockets are account-independent and survive.
    this.accountLifecycleUnsubscribe = this.accountLifecycleBus.subscribe(
      (signal: AccountLifecycleSignal) => {
        if (signal.type !== 'account.disabled') return;
        void this.handleAccountDisabled(signal.accountId).catch((error) => {
          this.logger.error(
            {
              accountId: signal.accountId,
              errorType: errorType(error),
            },
            'Failed to handle account disabled signal',
          );
        });
      },
    );
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    this.accountLifecycleUnsubscribe?.();
    for (const timer of this.disabledAccountRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.disabledAccountRetryTimers.clear();
    this.pendingDisabledAccounts.clear();
  }

  /** Publisher/CLI contexts may instantiate the module without Socket.IO. */
  isTransportReady(): boolean {
    // In required Redis mode, preserving outbox rows is safer than marking a
    // multi-instance delivery successful while the adapter is unavailable.
    return this.server !== undefined && this.redis.acceptsTraffic;
  }

  async handleConnection(socket: Socket): Promise<void> {
    if (!this.redis.acceptsTraffic) {
      socket.emit('error', { code: 'REALTIME_UNAVAILABLE' });
      socket.disconnect(true);
      return;
    }
    try {
      const client = await this.authenticate(socket);
      socket.data.auth = client;
      await socket.join(sessionRoom(client.liveSessionId));
      if (client.kind === 'teacher') {
        await socket.join(teacherRoom(client.liveSessionId));
      }
      await this.enqueueDelivery(socket, () =>
        this.replayOrSnapshot(socket, client, this.readCursor(socket)),
      );
      this.logger.log(
        {
          kind: client.kind,
          liveSessionId: client.liveSessionId,
          sid: socket.id,
        },
        'Socket connected',
      );
    } catch (error) {
      // Reject before room join: emit a stable error then disconnect. Never
      // leak why auth failed beyond the stable code. DomainError carries a
      // stable `code`; other throws collapse to UNAUTHORIZED (fail-closed).
      const code =
        error instanceof DomainError && error.code === 'SESSION_NOT_JOINABLE'
          ? 'SESSION_NOT_JOINABLE'
          : 'UNAUTHORIZED';
      this.logger.warn(
        {
          sid: socket.id,
          code,
          errorType: errorType(error),
        },
        'Socket connection rejected',
      );
      socket.emit('error', { code });
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket): void {
    this.deliveryQueues.delete(socket.id);
    this.logger.debug({ sid: socket.id }, 'Socket disconnected');
  }

  /**
   * Client-requested replay or snapshot (e.g. after a reconnect or a manual
   * refetch). The client may always ask for a fresh authoritative snapshot.
   */
  @SubscribeMessage('snapshot.fetch')
  async onSnapshotFetch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    if (!this.redis.acceptsTraffic) {
      socket.emit('error', { code: 'REALTIME_UNAVAILABLE' });
      socket.disconnect(true);
      return;
    }
    const client = socket.data.auth as AuthenticatedClient | undefined;
    if (!client) {
      socket.emit('error', { code: 'UNAUTHORIZED' });
      return;
    }
    const requestedCursor =
      isRecord(body) && 'lastEventSeq' in body ? body.lastEventSeq : undefined;
    await this.enqueueDelivery(socket, () =>
      this.replayOrSnapshot(socket, client, requestedCursor),
    );
  }

  private async enqueueDelivery(
    socket: { id: string },
    delivery: () => Promise<void> | void,
  ): Promise<void> {
    const previous = this.deliveryQueues.get(socket.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(delivery);
    this.deliveryQueues.set(socket.id, next);
    void next.then(
      () => this.clearDeliveryQueue(socket.id, next),
      () => this.clearDeliveryQueue(socket.id, next),
    );
    return next;
  }

  private clearDeliveryQueue(id: string, completed: Promise<void>): void {
    if (this.deliveryQueues.get(id) === completed) {
      this.deliveryQueues.delete(id);
    }
  }

  // --- auth ---------------------------------------------------------------

  private async authenticate(socket: Socket): Promise<AuthenticatedClient> {
    // Socket.IO handles its own handshake requests (GET /socket.io/...) before
    // they reach the express middleware stack, so cookie-parser does NOT
    // populate `request.cookies` here. Parse the raw Cookie header manually
    // (the __Host-session token is opaque/unsigned, so no secret is needed).
    const rawCookieHeader = socket.request.headers.cookie;
    const cookieJar = rawCookieHeader
      ? cookie.parse(rawCookieHeader)
      : undefined;
    const cookieToken = cookieJar?.[SESSION_COOKIE_NAME] as string | undefined;
    if (cookieToken) {
      return this.authenticateCookie(socket, cookieToken);
    }
    return this.authenticateParticipant(socket);
  }

  private async authenticateCookie(
    socket: Socket,
    cookieToken: string,
  ): Promise<AuthenticatedClient> {
    const { account } = await this.sessions.loadActiveSession(cookieToken);
    const liveSessionId = this.readLiveSessionIdParam(socket);
    if (account.role === AccountRole.STUDENT) {
      const participant = await this.participants.resolveAccountParticipant(
        liveSessionId,
        account.id,
      );
      return {
        kind: 'participant',
        participantId: participant.participantId,
        accountId: account.id,
        liveSessionId: participant.liveSessionId,
      };
    }

    // Verify course ownership/admin via the teacher detail read (non-owner →
    // 404 path). Reusing getTeacherDetail keeps "no existence leak" ordering
    // consistent with the REST S-2 endpoint.
    const detail = await this.liveSessions.getTeacherDetail(liveSessionId, {
      id: account.id,
      role: account.role,
    });
    if (!isJoinableLiveSessionStatus(detail.session.status)) {
      throw new DomainError(
        'SESSION_NOT_JOINABLE',
        'LiveSession cannot be joined.',
        409,
      );
    }
    return {
      kind: 'teacher',
      accountId: account.id,
      role: account.role,
      // Service reads normalize UUIDs; retain the canonical value for room
      // names and durable event routing so uppercase handshake input cannot
      // strand this socket outside the publisher's session room.
      liveSessionId: detail.session.id,
    };
  }

  private async authenticateParticipant(
    socket: Socket,
  ): Promise<AuthenticatedClient> {
    const auth = (socket.handshake.auth ?? {}) as {
      participantToken?: string;
      sessionCode?: string;
    };
    if (!auth.participantToken || !auth.sessionCode) {
      throw new Error('UNAUTHORIZED');
    }
    // Resolve the session code to a liveSessionId (throws SESSION_NOT_JOINABLE
    // for unknown/closed codes) and verify the participant token is bound to
    // that session (throws UNAUTHORIZED on mismatch). Reusing findByCode +
    // authenticate keeps the joinable check identical to the REST join path.
    const session = await this.liveSessions.findByCode(auth.sessionCode);
    const participant = await this.participants.authenticate(
      session.id,
      auth.participantToken,
    );
    if (participant.liveSessionId !== session.id) {
      throw new Error('UNAUTHORIZED');
    }
    return {
      kind: 'participant',
      participantId: participant.participantId,
      liveSessionId: session.id,
    };
  }

  private readLiveSessionIdParam(socket: Socket): string {
    const raw =
      (socket.handshake.auth?.liveSessionId as string | undefined) ??
      (socket.handshake.query?.liveSessionId as string | undefined);
    if (!raw || typeof raw !== 'string') {
      throw new Error('UNAUTHORIZED');
    }
    return raw;
  }

  // --- snapshot -----------------------------------------------------------

  private async sendSnapshot(
    socket: Socket,
    client: AuthenticatedClient,
    options: SnapshotDeliveryOptions = {},
  ): Promise<void> {
    if (client.kind === 'teacher') {
      const snapshot = await this.liveSessions.getTeacherRealtimeSnapshot(
        client.liveSessionId,
        {
          id: client.accountId,
          role: client.role,
        },
      );
      if (!isJoinableLiveSessionStatus(snapshot.session.status)) {
        socket.disconnect(true);
        return;
      }
      socket.emit(
        RealtimeEvent.SESSION_SNAPSHOT,
        this.envelope(
          RealtimeEvent.SESSION_SNAPSHOT,
          RealtimeVisibility.TEACHER,
          client.liveSessionId,
          options.eventSeq ?? snapshot.watermark.eventSeq,
          options.aggregateVersion ?? 0,
          {
            liveSession: toLiveSessionDto(snapshot.session, {
              joinedCount: snapshot.joinedCount,
              votedCount: snapshot.votedCount,
            }),
            watermark: snapshot.watermark,
            results: snapshot.results,
            ...(options.reason ? { reason: options.reason } : {}),
          },
          options.serverTimestamp,
        ),
      );
    } else {
      if (!(await this.reauthorizeParticipant(socket, client))) return;
      const view = await this.liveSessions.getParticipantSnapshot(
        client.liveSessionId,
        client.participantId,
        client.accountId,
      );
      socket.emit(
        RealtimeEvent.SESSION_SNAPSHOT,
        this.envelope(
          RealtimeEvent.SESSION_SNAPSHOT,
          RealtimeVisibility.PARTICIPANT,
          client.liveSessionId,
          options.eventSeq ?? view.watermark.eventSeq,
          options.aggregateVersion ?? 0,
          {
            liveSession: toParticipantLiveSessionDto(view),
            submittedQuestionIds: [...view.submittedQuestionIds],
            watermark: view.watermark,
            results: view.results,
            ...(options.reason ? { reason: options.reason } : {}),
          },
          options.serverTimestamp,
        ),
      );
    }
  }

  /**
   * WebSocket authorization is established at handshake time, but enrollment
   * and account status can change while the socket remains connected. Reuse the
   * account-bound resolver before every student projection/event path so a
   * removed or disabled student is disconnected instead of retaining room
   * access.
   */
  private async reauthorizeParticipant(
    socket: DisconnectableSocket,
    client: Extract<AuthenticatedClient, { kind: 'participant' }>,
  ): Promise<boolean> {
    if (!client.accountId) return true;
    try {
      const current = await this.participants.resolveAccountParticipant(
        client.liveSessionId,
        client.accountId,
      );
      if (current.participantId !== client.participantId) {
        socket.disconnect(true);
        return false;
      }
      return true;
    } catch (error) {
      if (!this.isExpectedAuthorizationFailure(error)) throw error;
      this.logger.debug(
        {
          sid: socket.id,
          liveSessionId: client.liveSessionId,
          errorType: errorType(error),
        },
        'Disconnected unauthorized participant socket',
      );
      socket.disconnect(true);
      return false;
    }
  }

  private async reauthorizeReplayClient(
    socket: DisconnectableSocket,
    client: AuthenticatedClient,
  ): Promise<boolean> {
    if (client.kind === 'participant') {
      return this.reauthorizeParticipant(socket, client);
    }
    try {
      await this.sessions.assertAccountActive(client.accountId);
      return true;
    } catch (error) {
      if (!this.isExpectedAuthorizationFailure(error)) throw error;
      socket.disconnect(true);
      return false;
    }
  }

  private isExpectedAuthorizationFailure(error: unknown): boolean {
    return (
      error instanceof DomainError &&
      [
        'FORBIDDEN',
        'NOT_FOUND',
        'SESSION_NOT_JOINABLE',
        'UNAUTHORIZED',
        // Stable enrollment-bound codes from the shared participant resolver:
        // a removed/missing enrollment must disconnect the socket, not crash
        // the shared broadcast batch.
        'ENROLLMENT_REQUIRED',
        'ENROLLMENT_REMOVED',
      ].includes(error.code)
    );
  }

  /** Remove account-bound sockets that lost enrollment or account status. */
  private async pruneUnauthorizedParticipantSockets(
    liveSessionId: string,
  ): Promise<void> {
    try {
      const sockets = await this.server
        .in(sessionRoom(liveSessionId))
        .fetchSockets();
      await Promise.all(
        sockets.map(async (socket) => {
          const client = socket.data?.auth as AuthenticatedClient | undefined;
          if (
            !client ||
            client.kind !== 'participant' ||
            client.liveSessionId !== liveSessionId
          ) {
            return;
          }
          await this.reauthorizeParticipant(socket, client);
        }),
      );
    } catch (error) {
      this.logger.warn(
        {
          liveSessionId,
          errorType: errorType(error),
        },
        'Could not enumerate participant sockets for reauthorization',
      );
      throw new Error('Could not enumerate participant sockets.');
    }
  }

  // --- signal handling ----------------------------------------------------

  /**
   * Disconnect every socket whose principal is the disabled account (teacher/
   * admin sockets and account-bound student participant sockets). Anonymous
   * participant sockets carry no `accountId` and are account-independent — they
   * are deliberately skipped. O(all sockets) is acceptable at single-instance
   * scale; cross-instance revocation is deferred (in-process bus guarantee).
   */
  private async handleAccountDisabled(accountId: string): Promise<void> {
    const canonicalAccountId = isUuid(accountId)
      ? normalizeUuid(accountId)
      : accountId;
    try {
      const sockets = await this.server.fetchSockets();
      await Promise.all(
        sockets.map(async (socket) => {
          const auth = socket.data?.auth as AuthenticatedClient | undefined;
          if (
            !auth ||
            !auth.accountId ||
            (isUuid(auth.accountId)
              ? normalizeUuid(auth.accountId)
              : auth.accountId) !== canonicalAccountId
          ) {
            return;
          }
          socket.disconnect(true);
        }),
      );
    } catch (error) {
      this.scheduleDisabledAccountRetry(canonicalAccountId);
      this.logger.warn(
        {
          accountId: canonicalAccountId,
          errorType: errorType(error),
        },
        'Could not enumerate account-disabled sockets; retry scheduled',
      );
      throw new Error('Could not enumerate account-disabled sockets.');
    }
    this.clearDisabledAccountRetry(canonicalAccountId);
  }

  private scheduleDisabledAccountRetry(accountId: string): void {
    if (this.shuttingDown || this.disabledAccountRetryTimers.has(accountId)) {
      return;
    }
    const attempt = this.pendingDisabledAccounts.get(accountId) ?? 0;
    const delay = Math.min(
      ACCOUNT_REVOCATION_RETRY_MAX_MS,
      ACCOUNT_REVOCATION_RETRY_INITIAL_MS * 2 ** attempt,
    );
    this.pendingDisabledAccounts.set(accountId, Math.min(attempt + 1, 5));
    const timer = setTimeout(() => {
      this.disabledAccountRetryTimers.delete(accountId);
      void this.handleAccountDisabled(accountId).catch(() => undefined);
    }, delay);
    this.disabledAccountRetryTimers.set(accountId, timer);
  }

  private clearDisabledAccountRetry(accountId: string): void {
    this.pendingDisabledAccounts.delete(accountId);
    const timer = this.disabledAccountRetryTimers.get(accountId);
    if (timer) clearTimeout(timer);
    this.disabledAccountRetryTimers.delete(accountId);
  }

  /**
   * Server-side fallback: before acting on any session signal, drop teacher
   * sockets whose account is no longer active, even if the account-disabled
   * signal was missed. The account row is the authority; handshake-time
   * ownership alone must not keep a disabled teacher connected.
   */
  private async pruneDisabledTeacherSockets(
    liveSessionId: string,
  ): Promise<void> {
    try {
      const sockets = await this.server
        .in(teacherRoom(liveSessionId))
        .fetchSockets();
      await Promise.all(
        sockets.map(async (socket) => {
          const auth = socket.data?.auth as AuthenticatedClient | undefined;
          if (!auth || auth.kind !== 'teacher') return;
          try {
            await this.sessions.assertAccountActive(auth.accountId);
          } catch (error) {
            if (!this.isExpectedAuthorizationFailure(error)) throw error;
            socket.disconnect(true);
          }
        }),
      );
    } catch (error) {
      this.logger.warn(
        {
          liveSessionId,
          errorType: errorType(error),
        },
        'Could not enumerate teacher sockets for account re-check',
      );
      throw new Error('Could not enumerate teacher sockets.');
    }
  }

  private readCursor(socket: Socket): unknown {
    const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
    return auth.lastEventSeq ?? socket.handshake.query?.lastEventSeq;
  }

  private async replayOrSnapshot(
    socket: Socket,
    client: AuthenticatedClient,
    rawCursor: unknown,
  ): Promise<void> {
    if (!(await this.reauthorizeReplayClient(socket, client))) return;

    try {
      const session = await this.liveSessions.getSnapshot(client.liveSessionId);
      if (!isJoinableLiveSessionStatus(session.status)) {
        socket.disconnect(true);
        return;
      }
    } catch {
      socket.disconnect(true);
      return;
    }

    const parsed = parseLastEventSeq(rawCursor);
    if (parsed.kind === 'absent') {
      await this.sendSnapshot(socket, client);
      return;
    }
    if (parsed.kind === 'invalid') {
      await this.sendSyncRequired(
        socket,
        client,
        RealtimeSyncReason.INVALID_CURSOR,
      );
      await this.sendSnapshot(socket, client, {
        reason: RealtimeSyncReason.INVALID_CURSOR,
      });
      return;
    }

    const now = new Date();
    const replayWindow = await this.prisma.prisma.$transaction(
      async (tx) => {
        const session = await tx.liveSession.findUnique({
          where: { id: client.liveSessionId },
          select: { realtimeEventSeq: true },
        });
        if (!session) {
          throw new DomainError(
            'SESSION_NOT_JOINABLE',
            'LiveSession cannot be joined.',
            409,
          );
        }
        const [oldest, rows] = await Promise.all([
          tx.liveSessionEvent.findFirst({
            where: { liveSessionId: client.liveSessionId },
            orderBy: { eventSeq: 'asc' },
            select: { eventSeq: true },
          }),
          tx.liveSessionEvent.findMany({
            where: {
              liveSessionId: client.liveSessionId,
              eventSeq: {
                gt: parsed.value,
                lte: session.realtimeEventSeq,
              },
            },
            orderBy: { eventSeq: 'asc' },
            take: REPLAY_LIMIT + 1,
          }),
        ]);
        return {
          currentEventSeq: session.realtimeEventSeq,
          oldestEventSeq: oldest?.eventSeq ?? null,
          rows,
          truncated: rows.length > REPLAY_LIMIT,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const rows = replayWindow.rows.slice(0, REPLAY_LIMIT);
    const replayRows: RealtimeReplayRow[] = rows.map((row) => ({
      eventSeq: row.eventSeq,
      event: row.eventName as RealtimeReplayRow['event'],
      visibility: row.visibility as RealtimeReplayRow['visibility'],
      deliveryState: row.deliveryState as RealtimeReplayRow['deliveryState'],
      visible: this.isVisibleToClient(row, client),
      coalesced: row.coalesced,
      expired: row.expiresAt !== null && row.expiresAt <= now,
    }));
    const decision = replayWindow.truncated
      ? { kind: 'sync_required' as const, reason: RealtimeSyncReason.GAP }
      : assessReplay({
          cursor: parsed.value,
          currentEventSeq: replayWindow.currentEventSeq,
          oldestRetainedEventSeq: replayWindow.oldestEventSeq,
          rows: replayRows,
        });
    if (decision.kind === 'sync_required') {
      await this.sendSyncRequired(socket, client, decision.reason);
      await this.sendSnapshot(socket, client, { reason: decision.reason });
      return;
    }
    if (decision.kind === 'snapshot') {
      await this.sendSnapshot(socket, client);
      return;
    }
    for (const replayRow of decision.events) {
      if (!(await this.reauthorizeReplayClient(socket, client))) return;
      const row = rows.find(
        (candidate) => candidate.eventSeq === BigInt(replayRow.eventSeq),
      );
      if (!row) break;
      await this.emitDurableEventToSocket(socket, client, row);
      if (replayRow.event === RealtimeEvent.SESSION_CLOSED) break;
    }
    const replayedSnapshot = decision.events.some(
      (row) => row.event === RealtimeEvent.SESSION_SNAPSHOT,
    );
    if (!decision.terminal && !replayedSnapshot) {
      await this.sendSnapshot(socket, client);
    }
  }

  private isVisibleToClient(
    row: DurableRealtimeEvent,
    client: AuthenticatedClient,
  ): boolean {
    const eventName = row.eventName as RealtimeEventName;
    if (client.kind === 'teacher') {
      // Teachers may materialize anonymous result aggregates even when the
      // originating notification is participant-after-submit scoped.
      return (
        eventName === RealtimeEvent.RESULT_UPDATED ||
        row.visibility === RealtimeVisibility.SESSION ||
        row.visibility === RealtimeVisibility.TEACHER
      );
    }
    if (row.visibility === RealtimeVisibility.SESSION) return true;
    if (row.visibility === RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT) {
      // Fail closed if a retained/corrupted row is missing its routing target.
      return (
        row.targetParticipantId !== null &&
        normalizeUuid(row.targetParticipantId) ===
          normalizeUuid(client.participantId)
      );
    }
    return row.visibility === RealtimeVisibility.PARTICIPANT;
  }

  private async sendSyncRequired(
    socket: Socket,
    client: AuthenticatedClient,
    reason: string,
  ): Promise<void> {
    const watermark = await this.liveSessions.getRealtimeWatermark(
      client.liveSessionId,
      client,
    );
    socket.emit(
      RealtimeEvent.SYNC_REQUIRED,
      this.envelope(
        RealtimeEvent.SYNC_REQUIRED,
        this.clientVisibility(client),
        client.liveSessionId,
        watermark.eventSeq,
        0,
        { reason, watermark },
      ),
    );
  }

  /** Recover sockets that were connected when a durable row became unusable. */
  async notifySyncRequiredForSession(
    liveSessionId: string,
    reason: RealtimeSyncReason,
  ): Promise<boolean> {
    if (!this.isTransportReady()) return false;
    let terminal = false;
    try {
      const session = await this.liveSessions.getSnapshot(liveSessionId);
      terminal = !isJoinableLiveSessionStatus(session.status);
    } catch (error) {
      this.logger.warn(
        {
          liveSessionId,
          reason,
          errorType: errorType(error),
        },
        'Could not read session status for realtime recovery',
      );
      return false;
    }
    let sockets;
    try {
      sockets = await this.server.in(sessionRoom(liveSessionId)).fetchSockets();
    } catch (error) {
      this.logger.warn(
        {
          liveSessionId,
          reason,
          errorType: errorType(error),
        },
        'Could not enumerate sockets for realtime recovery',
      );
      return false;
    }
    await Promise.all(
      sockets.map((remoteSocket) =>
        this.enqueueDelivery(remoteSocket, async () => {
          const client = remoteSocket.data?.auth as
            AuthenticatedClient | undefined;
          if (!client || client.liveSessionId !== liveSessionId) return;
          const socket = remoteSocket as unknown as Socket;
          if (terminal) {
            socket.disconnect(true);
            return;
          }
          if (client.kind === 'teacher') {
            try {
              await this.sessions.assertAccountActive(client.accountId);
            } catch (error) {
              if (!this.isExpectedAuthorizationFailure(error)) throw error;
              socket.disconnect(true);
              return;
            }
          } else if (!(await this.reauthorizeParticipant(socket, client))) {
            return;
          }
          try {
            await this.sendSyncRequired(socket, client, reason);
            await this.sendSnapshot(socket, client, { reason });
          } catch (error) {
            if (!this.isExpectedAuthorizationFailure(error)) throw error;
            // A snapshot cannot be read after a terminal or revoked session
            // boundary. The safe recovery action is to drop the stale socket;
            // the next join must authenticate against the current session state.
            this.logger.debug(
              {
                liveSessionId,
                reason,
                sid: socket.id,
                errorType: errorType(error),
              },
              'Realtime recovery snapshot unavailable; disconnecting socket',
            );
            socket.disconnect(true);
          }
        }),
      ),
    );
    return true;
  }

  /** Called by the bounded publisher after a row has been claimed. */
  async dispatchDurableEvent(event: DurableRealtimeEvent): Promise<void> {
    // Delivery methods reauthorize each recipient inside its per-socket queue.
    // Avoid a global room sweep before every event (O(session participants)).
    switch (event.eventName) {
      case RealtimeEvent.SESSION_SNAPSHOT:
        await this.emitTeacherSnapshot(event);
        return;
      case RealtimeEvent.SESSION_STATE_CHANGED: {
        await this.emitSharedEvent(event, {
          status: this.projectionString(event, 'status'),
        });
        await this.emitTeacherCounts(event.liveSessionId);
        if (this.projectionString(event, 'status') === 'cancelled') {
          await this.disconnectSessionSockets(event.liveSessionId);
        }
        return;
      }
      case RealtimeEvent.QUESTION_OPENED:
      case RealtimeEvent.QUESTION_CLOSED: {
        const sessionQuestionId = this.eventQuestionId(event);
        if (!sessionQuestionId) return;
        await this.emitSharedEvent(event, { sessionQuestionId });
        await this.emitTeacherCounts(event.liveSessionId);
        return;
      }
      case RealtimeEvent.RESULT_UPDATED:
        if (!this.eventQuestionId(event)) return;
        await this.emitTeacherCounts(event.liveSessionId);
        await this.emitTeacherResults(event);
        await this.emitParticipantResults(event);
        return;
      case RealtimeEvent.SESSION_CLOSED:
        await this.emitSessionClosed(event);
        return;
      case RealtimeEvent.SYNC_REQUIRED:
        return;
      default:
        throw new TypeError('Unknown durable realtime event.');
    }
  }

  private async emitTeacherSnapshot(
    event: DurableRealtimeEvent,
  ): Promise<void> {
    let sockets;
    try {
      sockets = await this.server
        .in(teacherRoom(event.liveSessionId))
        .fetchSockets();
    } catch {
      throw new Error('Could not enumerate teacher sockets.');
    }
    await Promise.all(
      sockets.map((remoteSocket) =>
        this.enqueueDelivery(remoteSocket, async () => {
          const client = remoteSocket.data?.auth as
            AuthenticatedClient | undefined;
          if (
            !client ||
            client.kind !== 'teacher' ||
            client.liveSessionId !== event.liveSessionId
          ) {
            return;
          }
          try {
            await this.sendSnapshot(remoteSocket as unknown as Socket, client, {
              eventSeq: toEventSeqWire(event.eventSeq),
              aggregateVersion: event.aggregateVersion,
              reason: this.projectionString(event, 'reason'),
              serverTimestamp: event.serverTimestamp.toISOString(),
            });
          } catch (error) {
            if (!this.isExpectedAuthorizationFailure(error)) throw error;
            (remoteSocket as unknown as DisconnectableSocket).disconnect(true);
          }
        }),
      ),
    );
    await this.emitTeacherCounts(event.liveSessionId);
  }

  private async emitSharedEvent(
    event: DurableRealtimeEvent,
    data: Record<string, unknown>,
  ): Promise<void> {
    const visibility = event.visibility as RealtimeVisibility;
    const room =
      visibility === RealtimeVisibility.TEACHER
        ? teacherRoom(event.liveSessionId)
        : sessionRoom(event.liveSessionId);
    let sockets;
    try {
      sockets = await this.server.in(room).fetchSockets();
    } catch {
      throw new Error('Could not enumerate shared sockets.');
    }
    const envelope = this.envelope(
      event.eventName as RealtimeEventName,
      visibility,
      event.liveSessionId,
      toEventSeqWire(event.eventSeq),
      event.aggregateVersion,
      data,
      event.serverTimestamp.toISOString(),
    );
    await Promise.all(
      sockets.map((remoteSocket) =>
        this.enqueueDelivery(remoteSocket, async () => {
          const client = remoteSocket.data?.auth as
            AuthenticatedClient | undefined;
          if (!client || client.liveSessionId !== event.liveSessionId) return;
          if (client.kind === 'teacher') {
            try {
              await this.sessions.assertAccountActive(client.accountId);
            } catch (error) {
              if (!this.isExpectedAuthorizationFailure(error)) throw error;
              remoteSocket.disconnect(true);
              return;
            }
          } else if (
            event.eventName !== RealtimeEvent.QUESTION_CLOSED &&
            data.status !== 'closed' &&
            !(await this.reauthorizeParticipant(remoteSocket, client))
          ) {
            return;
          }
          remoteSocket.emit(event.eventName, envelope);
        }),
      ),
    );
  }

  private async disconnectSessionSockets(liveSessionId: string): Promise<void> {
    let sockets;
    try {
      sockets = await this.server.in(sessionRoom(liveSessionId)).fetchSockets();
    } catch {
      throw new Error('Could not enumerate terminal sockets.');
    }
    await Promise.all(
      sockets.map(async (remoteSocket) => {
        const socket = remoteSocket as unknown as DisconnectableSocket;
        socket.disconnect(true);
      }),
    );
  }

  private async emitSessionClosed(event: DurableRealtimeEvent): Promise<void> {
    let sockets;
    try {
      sockets = await this.server
        .in(sessionRoom(event.liveSessionId))
        .fetchSockets();
    } catch {
      throw new Error('Could not enumerate closing sockets.');
    }
    await Promise.all(
      sockets.map((remoteSocket) =>
        this.enqueueDelivery(remoteSocket, async () => {
          const client = remoteSocket.data?.auth as
            AuthenticatedClient | undefined;
          if (!client || client.liveSessionId !== event.liveSessionId) return;
          const socket = remoteSocket as unknown as Socket;
          if (client.kind === 'teacher') {
            try {
              await this.sessions.assertAccountActive(client.accountId);
            } catch (error) {
              if (!this.isExpectedAuthorizationFailure(error)) throw error;
              socket.disconnect(true);
              return;
            }
          } else if (!(await this.reauthorizeParticipant(socket, client))) {
            return;
          }
          socket.emit(
            RealtimeEvent.SESSION_CLOSED,
            this.envelope(
              RealtimeEvent.SESSION_CLOSED,
              this.clientVisibility(client),
              event.liveSessionId,
              toEventSeqWire(event.eventSeq),
              event.aggregateVersion,
              { status: this.projectionString(event, 'status') ?? 'closed' },
              event.serverTimestamp.toISOString(),
            ),
          );
          setImmediate(() => socket.disconnect(true));
        }),
      ),
    );
  }

  private async emitDurableEventToSocket(
    socket: Socket,
    client: AuthenticatedClient,
    event: DurableRealtimeEvent,
  ): Promise<void> {
    const eventSeq = toEventSeqWire(event.eventSeq);
    switch (event.eventName) {
      case RealtimeEvent.SESSION_SNAPSHOT:
        if (client.kind === 'teacher') {
          await this.sendSnapshot(socket, client, {
            eventSeq,
            aggregateVersion: event.aggregateVersion,
            reason: this.projectionString(event, 'reason'),
            serverTimestamp: event.serverTimestamp.toISOString(),
          });
        }
        return;
      case RealtimeEvent.SESSION_STATE_CHANGED:
        socket.emit(
          RealtimeEvent.SESSION_STATE_CHANGED,
          this.envelope(
            RealtimeEvent.SESSION_STATE_CHANGED,
            event.visibility as RealtimeVisibility,
            event.liveSessionId,
            eventSeq,
            event.aggregateVersion,
            { status: this.projectionString(event, 'status') },
            event.serverTimestamp.toISOString(),
          ),
        );
        return;
      case RealtimeEvent.QUESTION_OPENED:
      case RealtimeEvent.QUESTION_CLOSED: {
        const sessionQuestionId = this.eventQuestionId(event);
        if (!sessionQuestionId) return;
        socket.emit(
          event.eventName,
          this.envelope(
            event.eventName,
            event.visibility as RealtimeVisibility,
            event.liveSessionId,
            eventSeq,
            event.aggregateVersion,
            { sessionQuestionId },
            event.serverTimestamp.toISOString(),
          ),
        );
        return;
      }
      case RealtimeEvent.RESULT_UPDATED:
        await this.emitResultToSocket(socket, client, event);
        return;
      case RealtimeEvent.SESSION_CLOSED:
        socket.emit(
          RealtimeEvent.SESSION_CLOSED,
          this.envelope(
            RealtimeEvent.SESSION_CLOSED,
            this.clientVisibility(client),
            event.liveSessionId,
            eventSeq,
            event.aggregateVersion,
            { status: this.projectionString(event, 'status') ?? 'closed' },
            event.serverTimestamp.toISOString(),
          ),
        );
        // Let Socket.IO flush the terminal packet before closing the transport.
        setImmediate(() => socket.disconnect(true));
        return;
      case RealtimeEvent.SYNC_REQUIRED:
        return;
    }
  }

  private async emitResultToSocket(
    socket: Socket,
    client: AuthenticatedClient,
    event: DurableRealtimeEvent,
  ): Promise<void> {
    const sessionQuestionId = this.eventQuestionId(event);
    if (!sessionQuestionId) return;
    if (
      client.kind === 'participant' &&
      event.visibility === RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT
    ) {
      // Fail closed if a retained/corrupted targeted row is missing its target.
      if (
        event.targetParticipantId === null ||
        normalizeUuid(event.targetParticipantId) !==
          normalizeUuid(client.participantId)
      ) {
        return;
      }
    }
    if (client.kind === 'teacher') {
      await this.sessions.assertAccountActive(client.accountId);
      const results = await this.liveSessions.getResults(
        event.liveSessionId,
        sessionQuestionId,
        {
          kind: 'teacher',
          accountId: client.accountId,
          role: client.role,
        },
      );
      socket.emit(
        RealtimeEvent.RESULT_UPDATED,
        this.envelope(
          RealtimeEvent.RESULT_UPDATED,
          RealtimeVisibility.TEACHER,
          event.liveSessionId,
          toEventSeqWire(event.eventSeq),
          event.aggregateVersion,
          { sessionQuestionId, results },
          event.serverTimestamp.toISOString(),
        ),
      );
      return;
    }
    if (!(await this.reauthorizeParticipant(socket, client))) return;
    try {
      const results = await this.liveSessions.getResults(
        event.liveSessionId,
        sessionQuestionId,
        {
          kind: 'participant',
          participantId: client.participantId,
          accountId: client.accountId,
        },
      );
      socket.emit(
        RealtimeEvent.RESULT_UPDATED,
        this.envelope(
          RealtimeEvent.RESULT_UPDATED,
          RealtimeVisibility.PARTICIPANT,
          event.liveSessionId,
          toEventSeqWire(event.eventSeq),
          event.aggregateVersion,
          { sessionQuestionId, results },
          event.serverTimestamp.toISOString(),
        ),
      );
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        error.code !== 'RESULTS_NOT_REVEALED'
      ) {
        throw error;
      }
      this.logger.debug(
        {
          liveSessionId: event.liveSessionId,
          sessionQuestionId,
          participantId: client.participantId,
        },
        'Skipped participant durable result (reveal gate)',
      );
    }
  }

  /** Teacher-only compatibility count notification. */
  private async emitTeacherCounts(liveSessionId: string): Promise<void> {
    let counts: { joinedCount: number; votedCount: number };
    try {
      const detail = await this.liveSessions.getTeacherDetail(liveSessionId, {
        id: '__realtime_recompute__',
        role: 'admin',
      });
      counts = {
        joinedCount: detail.joinedCount,
        votedCount: detail.votedCount,
      };
    } catch (error) {
      // A missing terminal session is a safe no-op; infrastructure failures
      // must propagate so the publisher retains the durable row for retry.
      if (!(error instanceof DomainError && error.code === 'NOT_FOUND')) {
        throw error;
      }
      this.logger.debug(
        {
          liveSessionId,
          errorType: errorType(error),
        },
        'Skipped counts.updated (session not readable)',
      );
      return;
    }

    let sockets;
    try {
      sockets = await this.server.in(teacherRoom(liveSessionId)).fetchSockets();
    } catch {
      throw new Error('Could not enumerate count sockets.');
    }
    const payload = {
      schemaVersion: 1,
      serverTimestamp: new Date().toISOString(),
      liveSessionId,
      visibility: RealtimeVisibility.TEACHER,
      data: counts,
    };
    await Promise.all(
      sockets.map((remoteSocket) =>
        this.enqueueDelivery(remoteSocket, async () => {
          const client = remoteSocket.data?.auth as
            AuthenticatedClient | undefined;
          if (
            !client ||
            client.kind !== 'teacher' ||
            client.liveSessionId !== liveSessionId
          ) {
            return;
          }
          try {
            await this.sessions.assertAccountActive(client.accountId);
          } catch (error) {
            if (!this.isExpectedAuthorizationFailure(error)) throw error;
            remoteSocket.disconnect(true);
            return;
          }
          remoteSocket.emit('counts.updated', payload);
        }),
      ),
    );
  }

  private async emitTeacherResults(event: DurableRealtimeEvent): Promise<void> {
    const sessionQuestionId = this.eventQuestionId(event);
    if (!sessionQuestionId) return;
    let results: SessionQuestionResultsDto;
    try {
      results = await this.liveSessions.getResults(
        event.liveSessionId,
        sessionQuestionId,
        {
          kind: 'teacher',
          accountId: '__realtime_recompute__',
          role: 'admin',
        },
      );
    } catch {
      throw new Error('Could not materialize teacher result.');
    }

    let sockets;
    try {
      sockets = await this.server
        .in(teacherRoom(event.liveSessionId))
        .fetchSockets();
    } catch {
      throw new Error('Could not enumerate teacher result sockets.');
    }
    const envelope = this.envelope(
      RealtimeEvent.RESULT_UPDATED,
      RealtimeVisibility.TEACHER,
      event.liveSessionId,
      toEventSeqWire(event.eventSeq),
      event.aggregateVersion,
      { sessionQuestionId, results },
      event.serverTimestamp.toISOString(),
    );
    await Promise.all(
      sockets.map((remoteSocket) =>
        this.enqueueDelivery(remoteSocket, async () => {
          const client = remoteSocket.data?.auth as
            AuthenticatedClient | undefined;
          if (
            !client ||
            client.kind !== 'teacher' ||
            client.liveSessionId !== event.liveSessionId
          ) {
            return;
          }
          try {
            await this.sessions.assertAccountActive(client.accountId);
          } catch (error) {
            if (!this.isExpectedAuthorizationFailure(error)) throw error;
            remoteSocket.disconnect(true);
            return;
          }
          remoteSocket.emit(RealtimeEvent.RESULT_UPDATED, envelope);
        }),
      ),
    );
  }

  private envelope<T extends Record<string, unknown>>(
    event: RealtimeEventName,
    visibility: RealtimeVisibility,
    liveSessionId: string,
    eventSeq: string,
    aggregateVersion: number,
    data: T,
    serverTimestamp?: string,
  ): RealtimeEventEnvelope<T> {
    return {
      event,
      schemaVersion: 1,
      eventSeq,
      aggregateVersion,
      serverTimestamp: serverTimestamp ?? new Date().toISOString(),
      liveSessionId,
      visibility,
      data,
    };
  }

  private async emitParticipantResults(
    event: DurableRealtimeEvent,
  ): Promise<void> {
    if (!this.eventQuestionId(event)) return;
    let remoteSockets;
    try {
      remoteSockets = await this.server
        .in(sessionRoom(event.liveSessionId))
        .fetchSockets();
    } catch {
      throw new Error('Could not enumerate participant sockets.');
    }
    const targetParticipantId =
      event.visibility === RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT &&
      event.targetParticipantId !== null &&
      isUuid(event.targetParticipantId)
        ? normalizeUuid(event.targetParticipantId)
        : undefined;
    const recipients =
      event.visibility === RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT
        ? targetParticipantId === undefined
          ? []
          : remoteSockets.filter((remoteSocket) => {
              const client = remoteSocket.data?.auth as
                AuthenticatedClient | undefined;
              return (
                client?.kind === 'participant' &&
                client.liveSessionId === event.liveSessionId &&
                isUuid(client.participantId) &&
                normalizeUuid(client.participantId) === targetParticipantId
              );
            })
        : remoteSockets;
    await Promise.all(
      recipients.map((remoteSocket) =>
        this.enqueueDelivery(remoteSocket, async () => {
          const client = remoteSocket.data?.auth as
            AuthenticatedClient | undefined;
          if (
            !client ||
            client.kind !== 'participant' ||
            client.liveSessionId !== event.liveSessionId
          ) {
            return;
          }
          await this.emitResultToSocket(
            remoteSocket as unknown as Socket,
            client,
            event,
          );
        }),
      ),
    );
  }

  private clientVisibility(client: AuthenticatedClient): RealtimeVisibility {
    return client.kind === 'teacher'
      ? RealtimeVisibility.TEACHER
      : RealtimeVisibility.PARTICIPANT;
  }

  private projectionString(
    event: DurableRealtimeEvent,
    key: string,
  ): string | undefined {
    if (!isRecord(event.projectionInput)) return undefined;
    const value = event.projectionInput[key];
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * The question FK is nullable so governance cleanup can retain event
   * evidence. Keep the safe immutable routing input as a fallback after that
   * cleanup rather than silently losing the event's question identity.
   */
  private eventQuestionId(event: DurableRealtimeEvent): string | undefined {
    if (event.sessionQuestionId) return normalizeUuid(event.sessionQuestionId);
    if (!isRecord(event.projectionInput)) return undefined;
    const value = event.projectionInput.sessionQuestionId;
    return typeof value === 'string' && isUuid(value)
      ? normalizeUuid(value)
      : undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
