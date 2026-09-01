import { Injectable, Logger } from '@nestjs/common';
import type { Participant } from '../../../../generated/prisma/client';
import {
  generateToken,
  hashToken,
  isUuid,
  newId,
  normalizeUuid,
} from '../../../common/crypto';
import {
  DomainError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from '../../../common/errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import {
  isJoinableLiveSessionStatus,
  toLiveSessionDto,
  LiveSessionService,
} from '../../live-sessions';
import { LiveSessionEventBus } from '../../realtime/live-session-event-bus';
import { LiveSessionOutboxService } from '../../realtime/live-session-outbox.service';
import {
  RealtimeCheckpointReason,
  RealtimeEvent,
  RealtimeVisibility,
} from '../../realtime/live-session-realtime-contract';
import { errorType } from '../../../common/observability';
import { AccountRole } from '../../identity/domain/roles';
import { AccountStatus } from '../../identity/domain/account-status';
import { EnrollmentStatus } from '../../enrollments/domain';
import { EnrollmentService } from '../../enrollments/application/enrollment.service';
import { normalizeParticipantDisplayName } from '../domain/display-name';

export const PARTICIPANT_TOKEN_HEADER = 'x-participant-token';

export interface ParticipantContext {
  participantId: string;
  liveSessionId: string;
  /** Present only for a cookie-bound student participant. */
  accountId?: string;
}

@Injectable()
export class ParticipantService {
  private readonly logger = new Logger(ParticipantService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly transactions: TransactionService,
    private readonly sessions: LiveSessionService,
    private readonly eventBus: LiveSessionEventBus,
    private readonly outbox: LiveSessionOutboxService,
    private readonly enrollments: EnrollmentService,
  ) {}

  private get db() {
    return this.prismaService.prisma;
  }

  async join(
    sessionCode: string,
    rawDisplayName: unknown,
  ): Promise<{
    participant: Participant;
    participantToken: string;
    liveSession: ReturnType<typeof toLiveSessionDto>;
  }> {
    const displayName = normalizeParticipantDisplayName(rawDisplayName);
    const session = await this.sessions.findByCode(sessionCode);
    const participantToken = generateToken();
    const tokenHash = hashToken(participantToken);

    const participant = await this.transactions.run(async (tx) => {
      await this.transactions.lockLiveSessionForUpdate(tx, session.id);
      const current = await tx.liveSession.findUnique({
        where: { id: session.id },
      });
      if (!current || !isJoinableLiveSessionStatus(current.status)) {
        throw new DomainError(
          'SESSION_NOT_JOINABLE',
          'LiveSession cannot be joined.',
          409,
        );
      }
      const participant = await tx.participant.create({
        data: {
          id: newId(),
          liveSessionId: current.id,
          displayName,
          tokenHash,
        },
      });
      await this.outbox.append(tx, {
        liveSessionId: current.id,
        event: RealtimeEvent.SESSION_SNAPSHOT,
        visibility: RealtimeVisibility.TEACHER,
        projectionInput: {
          reason: RealtimeCheckpointReason.PARTICIPANT_JOINED,
        },
      });
      return participant;
    });

    // Publish after the join transaction commits.
    this.publish({
      type: 'participant.joined',
      liveSessionId: participant.liveSessionId,
      participantId: participant.id,
    });

    return {
      participant,
      participantToken,
      liveSession: toLiveSessionDto(
        await this.sessions.getSnapshot(session.id),
      ),
    };
  }

  /**
   * Join or resume a student participant using the authenticated account.
   * The internal token hash keeps the existing schema invariant but the raw
   * token is discarded and never returned to the caller.
   */
  async joinForAccount(
    sessionCode: string,
    accountId: string,
  ): Promise<{
    participant: Participant;
    participantToken: null;
    liveSession: ReturnType<typeof toLiveSessionDto>;
  }> {
    const session = await this.sessions.findByCode(sessionCode);
    const { participant } = await this.findOrCreateAccountParticipant(
      session.id,
      accountId,
    );
    return {
      participant,
      participantToken: null,
      liveSession: toLiveSessionDto(
        await this.sessions.getSnapshot(session.id),
      ),
    };
  }

  /**
   * Resolve the account-bound participant for a student cookie. This is
   * idempotent and may create the row on the first authenticated snapshot or
   * submission, so all cookie paths share one identity and one uniqueness rule.
   */
  async resolveAccountParticipant(
    liveSessionId: string,
    accountId: string,
  ): Promise<ParticipantContext> {
    const { participant } = await this.findOrCreateAccountParticipant(
      liveSessionId,
      accountId,
    );
    return {
      participantId: participant.id,
      liveSessionId: participant.liveSessionId,
      accountId: participant.accountId ?? normalizeUuid(accountId),
    };
  }

  private async findOrCreateAccountParticipant(
    liveSessionId: string,
    accountId: string,
  ): Promise<{ participant: Participant; created: boolean }> {
    if (!isUuid(liveSessionId)) {
      throw new ValidationError(
        'LiveSession ID must be a UUID.',
        'liveSessionId',
      );
    }
    if (!isUuid(accountId)) {
      throw new ValidationError('Account ID must be a UUID.', 'accountId');
    }
    const canonicalLiveSessionId = normalizeUuid(liveSessionId);
    const canonicalAccountId = normalizeUuid(accountId);

    // Reuse the enrollment bounded context's public authorization primitive
    // before taking the live-session lock; the transaction below re-checks it
    // after the lock so a concurrent removal cannot grant access.
    const session = await this.db.liveSession.findUnique({
      where: { id: canonicalLiveSessionId },
      select: { courseId: true },
    });
    if (!session) {
      throw new DomainError(
        'SESSION_NOT_JOINABLE',
        'LiveSession cannot be joined.',
        409,
      );
    }
    await this.enrollments.assertActiveEnrollment(
      session.courseId,
      canonicalAccountId,
    );

    const result = await this.transactions.run(async (tx) => {
      await this.transactions.lockLiveSessionForUpdate(
        tx,
        canonicalLiveSessionId,
      );
      const current = await tx.liveSession.findUnique({
        where: { id: canonicalLiveSessionId },
        select: { id: true, courseId: true, status: true },
      });
      if (!current || !isJoinableLiveSessionStatus(current.status)) {
        throw new DomainError(
          'SESSION_NOT_JOINABLE',
          'LiveSession cannot be joined.',
          409,
        );
      }

      // Enrollment removal locks the Course row, while account disable locks
      // the Account row. Take both locks before rechecking authorization so a
      // participant cannot be created after either revocation commits. The
      // lock order is liveSession -> course -> account, matching the existing
      // live-session lifecycle path and avoiding a check-then-create race.
      await this.transactions.lockCourseForUpdate(tx, current.courseId);
      await this.transactions.lockAccountForUpdate(tx, canonicalAccountId);

      const account = await tx.account.findUnique({
        where: { id: canonicalAccountId },
        select: { id: true, role: true, status: true, displayName: true },
      });
      if (
        !account ||
        account.role !== AccountRole.STUDENT ||
        account.status !== AccountStatus.ACTIVE
      ) {
        throw new ForbiddenError('Active student account required');
      }

      const enrollment = await tx.courseEnrollment.findUnique({
        where: {
          courseId_studentAccountId: {
            courseId: current.courseId,
            studentAccountId: canonicalAccountId,
          },
        },
        select: { status: true },
      });
      if (!enrollment || enrollment.status !== EnrollmentStatus.ACTIVE) {
        throw new ForbiddenError('Active course enrollment required');
      }

      const existing = await tx.participant.findUnique({
        where: {
          liveSessionId_accountId: {
            liveSessionId: canonicalLiveSessionId,
            accountId: canonicalAccountId,
          },
        },
      });
      if (existing) return { participant: existing, created: false };

      const participant = await tx.participant.create({
        data: {
          id: newId(),
          liveSessionId: canonicalLiveSessionId,
          accountId: canonicalAccountId,
          displayName: normalizeParticipantDisplayName(account.displayName),
          // Account-bound callers never receive this raw value.
          tokenHash: hashToken(generateToken()),
        },
      });
      await this.outbox.append(tx, {
        liveSessionId: canonicalLiveSessionId,
        event: RealtimeEvent.SESSION_SNAPSHOT,
        visibility: RealtimeVisibility.TEACHER,
        projectionInput: {
          reason: RealtimeCheckpointReason.PARTICIPANT_JOINED,
        },
      });
      return { participant, created: true };
    });

    if (result.created) {
      // Publish only after the account-bound participant transaction commits.
      this.publish({
        type: 'participant.joined',
        liveSessionId: result.participant.liveSessionId,
        participantId: result.participant.id,
      });
    }
    return result;
  }

  /**
   * Fire-and-forget realtime signal publish (post-commit). A failure is logged
   * and swallowed so it can never fail the domain mutation.
   */
  private publish(signal: Parameters<LiveSessionEventBus['publish']>[0]): void {
    void this.eventBus.publish(signal).catch((error) => {
      this.logger.error(
        {
          signalType: signal.type,
          liveSessionId: signal.liveSessionId,
          errorType: errorType(error),
        },
        'Realtime publish failed; mutation already committed',
      );
    });
  }

  async authenticate(
    liveSessionId: string,
    rawToken: string | undefined,
  ): Promise<ParticipantContext> {
    if (!rawToken) throw new UnauthorizedError();
    if (!isUuid(liveSessionId)) {
      throw new ValidationError(
        'LiveSession ID must be a UUID.',
        'liveSessionId',
      );
    }
    const canonicalLiveSessionId = normalizeUuid(liveSessionId);
    const tokenHash = hashToken(rawToken);
    const participant = await this.db.participant.findFirst({
      where: { liveSessionId: canonicalLiveSessionId, tokenHash },
      include: { liveSession: true },
    });
    if (!participant) throw new UnauthorizedError();
    // Account-bound participants authenticate through the student session
    // cookie, never through the anonymous bearer-token path.
    if (participant.accountId !== null) throw new UnauthorizedError();
    if (!isJoinableLiveSessionStatus(participant.liveSession.status)) {
      throw new DomainError(
        'SESSION_NOT_JOINABLE',
        'LiveSession cannot be joined.',
        409,
      );
    }
    return {
      participantId: participant.id,
      liveSessionId: participant.liveSessionId,
    };
  }
}
