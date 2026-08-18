import { Logger, OnModuleInit } from '@nestjs/common';
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
import { SessionService } from '../../common/auth/session.service';
import { DomainError } from '../../common/errors';
import { SESSION_COOKIE_NAME } from '../../common/security';
import {
  LiveSessionService,
  toLiveSessionDto,
} from '../live-sessions/application/live-session.service';
import {
  LiveSessionStatus,
  SessionQuestionStatus,
} from '../live-sessions/domain';
import { AccountRole } from '../identity/domain/roles';
import { ParticipantService } from '../participants/application/participant.service';
import {
  LiveSessionEventBus,
  type LiveSessionSignal,
} from './live-session-event-bus';

/**
 * R-1 lite Socket.IO gateway (namespace `/live`).
 *
 * Handshake authentication reuses the existing Web session cookie (teacher) and
 * participant token + session code (participant) paths. PostgreSQL stays the
 * sole authority; sockets are notification-only. The gateway subscribes to
 * `LiveSessionEventBus` and, on each post-commit signal, recomputes a
 * visibility-safe projection via the existing read services and emits the
 * corresponding Socket.IO event.
 *
 * Lite scope (divergence from M2 event envelope, reconciled when R-1 adds the
 * outbox): events carry `schemaVersion`, `serverTimestamp`, `liveSessionId`,
 * `visibility`, `data` but **no** `eventSeq`/`aggregateVersion` — they are
 * non-durable and a reconnect simply fetches a fresh `session.snapshot`.
 */

const LIVE_NAMESPACE = 'live';
const SCHEMA_VERSION = 1;

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
  implements OnModuleInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(LiveGateway.name);
  private unsubscribe?: () => void;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly sessions: SessionService,
    private readonly liveSessions: LiveSessionService,
    private readonly participants: ParticipantService,
    private readonly bus: LiveSessionEventBus,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((signal) => {
      // Recompute/emit can throw on a transient DB issue — guard per-signal so
      // a downstream failure does not affect the bus or other signals. The
      // bus itself also isolates listener errors; this is defense in depth.
      void this.handleSignal(signal).catch((error) => {
        this.logger.error(
          {
            signalType: signal.type,
            liveSessionId: signal.liveSessionId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to handle realtime signal',
        );
      });
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const client = await this.authenticate(socket);
      socket.data.auth = client;
      socket.join(sessionRoom(client.liveSessionId));
      if (client.kind === 'teacher') {
        socket.join(teacherRoom(client.liveSessionId));
      }
      await this.sendSnapshot(socket, client);
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
          err: error instanceof Error ? error.message : String(error),
        },
        'Socket connection rejected',
      );
      socket.emit('error', { code });
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket): void {
    this.logger.debug({ sid: socket.id }, 'Socket disconnected');
  }

  /**
   * Client-requested snapshot (e.g. after a reconnect or a manual refetch).
   * Lite: the client may always ask for a fresh authoritative snapshot.
   */
  @SubscribeMessage('snapshot.fetch')
  async onSnapshotFetch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() _body: unknown,
  ): Promise<void> {
    const client = socket.data.auth as AuthenticatedClient | undefined;
    if (!client) {
      socket.emit('error', { code: 'UNAUTHORIZED' });
      return;
    }
    await this.sendSnapshot(socket, client);
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
    await this.liveSessions.getTeacherDetail(liveSessionId, {
      id: account.id,
      role: account.role,
    });
    return {
      kind: 'teacher',
      accountId: account.id,
      role: account.role,
      liveSessionId,
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
  ): Promise<void> {
    if (client.kind === 'teacher') {
      const { session, joinedCount, votedCount } =
        await this.liveSessions.getTeacherDetail(client.liveSessionId, {
          id: client.accountId,
          role: client.role,
        });
      socket.emit(
        'session.snapshot',
        this.envelope('teacher', client.liveSessionId, {
          liveSession: toLiveSessionDto(session, { joinedCount, votedCount }),
        }),
      );
    } else {
      if (!(await this.reauthorizeParticipant(socket, client))) return;
      const view = await this.liveSessions.getParticipantSnapshot(
        client.liveSessionId,
        client.participantId,
        client.accountId,
      );
      socket.emit(
        'session.snapshot',
        this.envelope('participant', client.liveSessionId, {
          liveSession: toParticipantLiveSessionDto(view),
          submittedQuestionIds: [...view.submittedQuestionIds],
        }),
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
      this.logger.debug(
        {
          sid: socket.id,
          liveSessionId: client.liveSessionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Disconnected unauthorized participant socket',
      );
      socket.disconnect(true);
      return false;
    }
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
      this.logger.debug(
        {
          liveSessionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Skipped participant socket reauthorization (fetchSockets failed)',
      );
    }
  }

  // --- signal handling ----------------------------------------------------

  private async handleSignal(signal: LiveSessionSignal): Promise<void> {
    await this.pruneUnauthorizedParticipantSockets(signal.liveSessionId);
    const liveSessionId = signal.liveSessionId;
    switch (signal.type) {
      case 'participant.joined':
        await this.emitTeacherCounts(liveSessionId);
        break;
      case 'question.opened':
        this.server.to(sessionRoom(liveSessionId)).emit(
          'question.opened',
          this.envelope('all', liveSessionId, {
            sessionQuestionId: signal.sessionQuestionId,
          }),
        );
        await this.emitTeacherCounts(liveSessionId);
        break;
      case 'question.closed':
        this.server.to(sessionRoom(liveSessionId)).emit(
          'question.closed',
          this.envelope('all', liveSessionId, {
            sessionQuestionId: signal.sessionQuestionId,
          }),
        );
        await this.emitTeacherCounts(liveSessionId);
        await this.emitTeacherResults(liveSessionId, signal.sessionQuestionId);
        // After close, results are revealed to every connected participant
        // (vote-to-reveal passes once the question is closed). Push a
        // participant-safe projection per client so quiz correctness is not
        // leaked before close and teacher-only fields stay teacher-only.
        await this.emitParticipantResults(
          liveSessionId,
          signal.sessionQuestionId,
        );
        break;
      case 'session.state_changed':
        this.server
          .to(sessionRoom(liveSessionId))
          .emit(
            'session.state_changed',
            this.envelope('all', liveSessionId, { status: signal.status }),
          );
        if (signal.status === LiveSessionStatus.CLOSED) {
          this.server
            .to(sessionRoom(liveSessionId))
            .emit('session.closed', this.envelope('all', liveSessionId, {}));
        }
        break;
      case 'submission.committed':
        await this.emitTeacherCounts(liveSessionId);
        await this.emitTeacherResults(liveSessionId, signal.sessionQuestionId);
        // Push a participant-safe result to the submitting participant only.
        // While the question is open, vote-to-reveal gates everyone else out;
        // only the submitter may view the aggregate (US-F17). Other
        // participants will receive their result on `question.closed`.
        await this.emitParticipantResults(
          liveSessionId,
          signal.sessionQuestionId,
          signal.participantId,
        );
        break;
    }
  }

  /**
   * Teacher-only room. Recompute counts from authoritative rows.
   *
   * The `getTeacherDetail` call requires a caller; teacher-room members were
   * verified as owner/admin at connect time, so an internal recompute may use
   * the admin path. The connect-time ownership check is the real gate; this
   * recompute is a convenience projection for already-authed teachers.
   */
  private async emitTeacherCounts(liveSessionId: string): Promise<void> {
    try {
      const { joinedCount, votedCount } =
        await this.liveSessions.getTeacherDetail(liveSessionId, {
          id: '__realtime_recompute__',
          role: 'admin',
        });
      this.server
        .to(teacherRoom(liveSessionId))
        .emit(
          'counts.updated',
          this.envelope('teacher', liveSessionId, { joinedCount, votedCount }),
        );
    } catch (error) {
      this.logger.debug(
        {
          liveSessionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Skipped counts.updated (session not readable)',
      );
    }
  }

  private async emitTeacherResults(
    liveSessionId: string,
    sessionQuestionId: string,
  ): Promise<void> {
    try {
      const results = await this.liveSessions.getResults(
        liveSessionId,
        sessionQuestionId,
        {
          kind: 'teacher',
          accountId: '__realtime_recompute__',
          role: 'admin',
        },
      );
      this.server.to(teacherRoom(liveSessionId)).emit(
        'result.updated',
        this.envelope('teacher', liveSessionId, {
          sessionQuestionId,
          results,
        }),
      );
    } catch (error) {
      this.logger.debug(
        {
          liveSessionId,
          sessionQuestionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Skipped teacher result.updated (question not readable)',
      );
    }
  }

  private envelope<T extends Record<string, unknown>>(
    visibility: string,
    liveSessionId: string,
    data: T,
  ) {
    return {
      schemaVersion: SCHEMA_VERSION,
      serverTimestamp: new Date().toISOString(),
      liveSessionId,
      visibility,
      data,
    };
  }

  /**
   * Push a participant-safe `result.updated` to connected participants. Each
   * participant receives its own vote-to-reveal projection computed via
   * `getResults({ kind: 'participant', participantId })` — never the teacher
   * projection. A participant whose reveal gate fails (open + not yet
   * submitted, or not_open) is silently skipped (no event), which is the same
   * contract as the REST results endpoint.
   *
   * When `onlyParticipantId` is given (submission.committed path), only that
   * participant is targeted; otherwise (question.closed path) every connected
   * participant in the session room is targeted.
   */
  private async emitParticipantResults(
    liveSessionId: string,
    sessionQuestionId: string,
    onlyParticipantId?: string,
  ): Promise<void> {
    let remoteSockets;
    try {
      remoteSockets = await this.server
        .in(sessionRoom(liveSessionId))
        .fetchSockets();
    } catch (error) {
      this.logger.debug(
        {
          liveSessionId,
          sessionQuestionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Skipped participant result.updated (fetchSockets failed)',
      );
      return;
    }
    const targets = remoteSockets
      .map((socket) => {
        const auth = socket.data?.auth as AuthenticatedClient | undefined;
        if (auth?.kind !== 'participant') return null;
        if (auth.liveSessionId !== liveSessionId) return null;
        if (
          onlyParticipantId !== undefined &&
          auth.participantId !== onlyParticipantId
        ) {
          return null;
        }
        return { socketId: socket.id, socket, client: auth };
      })
      .filter(
        (
          value,
        ): value is {
          socketId: string;
          socket: (typeof remoteSockets)[number];
          client: Extract<AuthenticatedClient, { kind: 'participant' }>;
        } => value !== null,
      );
    await Promise.all(
      targets.map(async ({ socketId, socket: remoteSocket, client }) => {
        try {
          const socket = remoteSocket as unknown as Socket;
          if (!(await this.reauthorizeParticipant(socket, client))) {
            return;
          }
          const results = await this.liveSessions.getResults(
            liveSessionId,
            sessionQuestionId,
            {
              kind: 'participant',
              participantId: client.participantId,
              accountId: client.accountId,
            },
          );
          this.server.to(socketId).emit(
            'result.updated',
            this.envelope('participant', liveSessionId, {
              sessionQuestionId,
              results,
            }),
          );
        } catch (error) {
          // RESULTS_NOT_REVEALED / SESSION_QUESTION_NOT_OPEN: this participant
          // is not eligible to see results yet — no event. Any other DomainError
          // is also non-fatal; we never block the signal pipeline.
          this.logger.debug(
            {
              liveSessionId,
              sessionQuestionId,
              participantId: client.participantId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Skipped participant result.updated (reveal gate)',
          );
        }
      }),
    );
  }
}
