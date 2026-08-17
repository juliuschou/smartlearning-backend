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
import { normalizeParticipantDisplayName } from '../domain/display-name';

export const PARTICIPANT_TOKEN_HEADER = 'x-participant-token';

export interface ParticipantContext {
  participantId: string;
  liveSessionId: string;
}

@Injectable()
export class ParticipantService {
  private readonly logger = new Logger(ParticipantService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly transactions: TransactionService,
    private readonly sessions: LiveSessionService,
    private readonly eventBus: LiveSessionEventBus,
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
      return tx.participant.create({
        data: {
          id: newId(),
          liveSessionId: current.id,
          displayName,
          tokenHash,
        },
      });
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
   * Fire-and-forget realtime signal publish (post-commit). A failure is logged
   * and swallowed so it can never fail the domain mutation.
   */
  private publish(signal: Parameters<LiveSessionEventBus['publish']>[0]): void {
    void this.eventBus.publish(signal).catch((error) => {
      this.logger.error(
        {
          signalType: signal.type,
          liveSessionId: signal.liveSessionId,
          err: error instanceof Error ? error.message : String(error),
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
