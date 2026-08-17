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
import { LiveSessionStatus } from '../live-sessions/domain';
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
      return this.authenticateTeacher(socket, cookieToken);
    }
    return this.authenticateParticipant(socket);
  }

  private async authenticateTeacher(
    socket: Socket,
    cookieToken: string,
  ): Promise<AuthenticatedClient> {
    const { account } = await this.sessions.loadActiveSession(cookieToken);
    const liveSessionId = this.readLiveSessionIdParam(socket);
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
      const view = await this.liveSessions.getParticipantSnapshot(
        client.liveSessionId,
        client.participantId,
      );
      socket.emit(
        'session.snapshot',
        this.envelope('participant', client.liveSessionId, {
          liveSession: toLiveSessionDto(view.session),
          submittedQuestionIds: [...view.submittedQuestionIds],
        }),
      );
    }
  }

  // --- signal handling ----------------------------------------------------

  private async handleSignal(signal: LiveSessionSignal): Promise<void> {
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
      this.server
        .to(teacherRoom(liveSessionId))
        .emit(
          'result.updated',
          this.envelope('teacher', liveSessionId, { results }),
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
}
