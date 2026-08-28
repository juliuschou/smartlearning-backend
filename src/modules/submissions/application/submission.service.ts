import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { isUuid, newId, normalizeUuid } from '../../../common/crypto';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../../common/errors';
import { TransactionService } from '../../../prisma/transaction.service';
import {
  LiveSessionStatus,
  SessionQuestionStatus,
} from '../../live-sessions/domain';
import { AccountRole } from '../../identity/domain/roles';
import { AccountStatus } from '../../identity/domain/account-status';
import { EnrollmentStatus } from '../../enrollments/domain';
import { LiveSessionEventBus } from '../../realtime/live-session-event-bus';
import { LiveSessionOutboxService } from '../../realtime/live-session-outbox.service';
import {
  RealtimeEvent,
  RealtimeVisibility,
} from '../../realtime/live-session-realtime-contract';
import type { ParticipantContext } from '../../participants/application/participant.service';
import type { CreateSubmissionDto } from '../api/dto';
import {
  canonicalRefFingerprint,
  normalizeTextAnswer,
  throwOnAnswerIssues,
  validateAnswer,
} from '../domain/answer-contract';

export interface SubmissionProjection {
  id: string;
  liveSessionId: string;
  sessionQuestionId: string;
  participantId: string;
  selectedOptionRefs: string[] | null;
  textAnswer: string | null;
  submittedAt: Date;
}

@Injectable()
export class SubmissionService {
  private readonly logger = new Logger(SubmissionService.name);

  constructor(
    private readonly transactions: TransactionService,
    private readonly eventBus: LiveSessionEventBus,
    private readonly outbox: LiveSessionOutboxService,
  ) {}

  /**
   * Fire-and-forget realtime signal publish (post-commit). A failure is logged
   * and swallowed so it can never fail the domain mutation. Only the accepted
   * (fresh or idempotent-replay) path reaches here; the conflict throws never
   * publish.
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

  async submit(
    liveSessionId: string,
    participant: ParticipantContext | undefined,
    idempotencyKey: string | undefined,
    dto: CreateSubmissionDto,
  ): Promise<SubmissionProjection> {
    if (!participant) throw new UnauthorizedError();
    const canonicalLiveSessionId = normalizeUuid(liveSessionId);
    const canonicalQuestionId = normalizeUuid(dto.sessionQuestionId);
    const canonicalParticipantId = normalizeUuid(participant.participantId);
    if (normalizeUuid(participant.liveSessionId) !== canonicalLiveSessionId) {
      throw new UnauthorizedError();
    }
    if (!idempotencyKey || !isUuid(idempotencyKey)) {
      throw new ValidationError(
        'A UUID Idempotency-Key is required.',
        'Idempotency-Key',
      );
    }
    const canonicalIdempotencyKey = normalizeUuid(idempotencyKey);
    const rawSelectedOptionRefs = dto.selectedOptionRefs ?? [];
    const selectedOptionRefs = rawSelectedOptionRefs.map(
      normalizeSubmissionRef,
    );
    const textAnswer =
      dto.textAnswer !== undefined && dto.textAnswer !== null
        ? normalizeTextAnswer(dto.textAnswer)
        : null;

    const result = await this.transactions.run(async (tx) => {
      // Match closeSession's live_session → session_question order so the
      // submit/close race has one PostgreSQL lock protocol and cannot cycle.
      await this.transactions.lockLiveSessionForUpdate(
        tx,
        canonicalLiveSessionId,
      );
      await this.transactions.lockSessionQuestionForUpdate(
        tx,
        canonicalQuestionId,
      );
      const question = await tx.sessionQuestion.findUnique({
        where: { id: canonicalQuestionId },
        include: {
          liveSession: true,
          options: { orderBy: { position: 'asc' } },
        },
      });
      if (!question || question.liveSessionId !== canonicalLiveSessionId) {
        throw new NotFoundError(
          'SessionQuestion not found',
          'sessionQuestionId',
        );
      }
      const owner = await tx.participant.findUnique({
        where: { id: canonicalParticipantId },
      });
      if (!owner || owner.liveSessionId !== canonicalLiveSessionId) {
        throw new UnauthorizedError();
      }
      const ownerAccountId = owner.accountId
        ? normalizeUuid(owner.accountId)
        : undefined;
      const contextAccountId = participant.accountId
        ? normalizeUuid(participant.accountId)
        : undefined;
      if (ownerAccountId !== contextAccountId) {
        throw new UnauthorizedError();
      }
      if (ownerAccountId !== undefined) {
        // Revalidate cookie-bound identity inside the submission transaction.
        // The guard may have run before a roster removal/account disable, so
        // lock the same Course and Account rows before the final check.
        await this.transactions.lockCourseForUpdate(
          tx,
          question.liveSession.courseId,
        );
        await this.transactions.lockAccountForUpdate(tx, ownerAccountId);
        const account = await tx.account.findUnique({
          where: { id: ownerAccountId },
          select: { role: true, status: true },
        });
        const enrollment = await tx.courseEnrollment.findUnique({
          where: {
            courseId_studentAccountId: {
              courseId: question.liveSession.courseId,
              studentAccountId: ownerAccountId,
            },
          },
          select: { status: true },
        });
        if (
          !account ||
          account.role !== AccountRole.STUDENT ||
          account.status !== AccountStatus.ACTIVE ||
          enrollment?.status !== EnrollmentStatus.ACTIVE
        ) {
          throw new ForbiddenError('Active course enrollment required');
        }
      }

      const optionIdsByFormalId = new Map<string, string>();
      const optionIdsByRef = new Map<string, string>();
      for (const option of question.options) {
        optionIdsByFormalId.set(option.id, option.id);
        if (option.optionRef) optionIdsByRef.set(option.optionRef, option.id);
      }
      const canonicalSelectedOptionRefs = selectedOptionRefs.map(
        (optionRef) => {
          const formalIdMatch = optionIdsByFormalId.get(optionRef);
          if (formalIdMatch) return formalIdMatch;
          if (isUuid(optionRef)) {
            const normalizedFormalId = optionIdsByFormalId.get(
              normalizeUuid(optionRef),
            );
            if (normalizedFormalId) return normalizedFormalId;
          }
          return optionIdsByRef.get(optionRef) ?? optionRef;
        },
      );

      const existingByKey = await tx.submission.findUnique({
        where: { idempotencyKey: canonicalIdempotencyKey },
      });
      if (existingByKey) {
        if (
          sameSubmissionPayload(
            existingByKey,
            canonicalParticipantId,
            question.id,
            canonicalSelectedOptionRefs,
            textAnswer,
          )
        ) {
          return {
            submission: toSubmissionProjection(existingByKey),
            fresh: false,
          };
        }
        throw new DomainError(
          'SUBMISSION_CONFLICT',
          'Idempotency-Key is already bound to a different submission.',
          409,
          'Idempotency-Key',
          'Retry with the original payload or use a new key only for a new question.',
        );
      }

      if (
        question.liveSession.status !== LiveSessionStatus.ACTIVE ||
        question.status !== SessionQuestionStatus.OPEN
      ) {
        throw new ConflictError(
          'Only an active session and open question accept submissions.',
          'status',
        );
      }

      const answerIssues = validateAnswer({
        snapshotType: question.snapshotType as 'poll' | 'open_text' | 'quiz',
        snapshotSelectionMode: question.snapshotSelectionMode as
          'single' | 'multiple' | null,
        options: question.options.map((option) => ({
          id: option.id,
          isCorrect: option.isCorrect,
        })),
        selectedOptionRefs:
          canonicalSelectedOptionRefs.length > 0
            ? canonicalSelectedOptionRefs
            : null,
        textAnswer,
      });
      throwOnAnswerIssues(answerIssues);

      const existingByParticipant = await tx.submission.findUnique({
        where: {
          participantId_sessionQuestionId: {
            participantId: canonicalParticipantId,
            sessionQuestionId: question.id,
          },
        },
      });
      if (existingByParticipant) {
        throw new DomainError(
          'SUBMISSION_CONFLICT',
          'Participant has already submitted this question.',
          409,
          'selectedOptionRefs',
          'The first accepted answer is immutable.',
        );
      }

      // Persist the option refs OR the text answer, mutually exclusive by
      // question snapshot type (guarded above by validateAnswer).
      const isOptionAnswer = question.snapshotType !== 'open_text';
      try {
        const created = await tx.submission.create({
          data: {
            id: newId(),
            liveSessionId: canonicalLiveSessionId,
            sessionQuestionId: question.id,
            participantId: canonicalParticipantId,
            idempotencyKey: canonicalIdempotencyKey,
            selectedOptionRefs: isOptionAnswer
              ? canonicalSelectedOptionRefs
              : Prisma.DbNull,
            textAnswer: isOptionAnswer ? null : textAnswer,
          },
        });
        const versionedQuestion = await tx.sessionQuestion.update({
          where: { id: question.id },
          data: { aggregateVersion: { increment: 1 } },
          select: { aggregateVersion: true },
        });
        await this.outbox.append(tx, {
          liveSessionId: canonicalLiveSessionId,
          sessionQuestionId: question.id,
          targetParticipantId: canonicalParticipantId,
          event: RealtimeEvent.RESULT_UPDATED,
          visibility: RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
          aggregateVersion: versionedQuestion.aggregateVersion,
          projectionInput: { status: question.status },
          serverTimestamp: created.submittedAt,
        });
        return {
          submission: toSubmissionProjection(created),
          fresh: true,
        };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new DomainError(
            'SUBMISSION_CONFLICT',
            'Submission conflicts with an already committed answer.',
            409,
            'selectedOptionRefs',
          );
        }
        throw error;
      }
    });
    // Publish after the submission transaction commits. A same-key replay
    // returns the original row but does not create another durable result event
    // or wake notification.
    if (result.fresh) {
      this.publish({
        type: 'submission.committed',
        liveSessionId: result.submission.liveSessionId,
        sessionQuestionId: result.submission.sessionQuestionId,
        participantId: result.submission.participantId,
      });
    }
    return result.submission;
  }
}

function normalizeSubmissionRef(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function sameSubmissionPayload(
  existing: {
    participantId: string;
    sessionQuestionId: string;
    selectedOptionRefs: Prisma.JsonValue | null;
    textAnswer: string | null;
  },
  participantId: string,
  sessionQuestionId: string,
  selectedOptionRefs: readonly string[],
  textAnswer: string | null,
): boolean {
  if (
    existing.participantId !== participantId ||
    existing.sessionQuestionId !== sessionQuestionId
  ) {
    return false;
  }
  // Option answers: compare the canonical (sorted) ref set so a different input
  // order for the same answer still hits idempotent replay (poll multiple / quiz
  // exact-set are order-independent).
  const existingRefs = asStringArray(existing.selectedOptionRefs);
  if (existingRefs !== null) {
    return (
      JSON.stringify(canonicalRefFingerprint(existingRefs)) ===
      JSON.stringify(canonicalRefFingerprint(selectedOptionRefs))
    );
  }
  // Text answers: compare normalized text.
  return existing.textAnswer === textAnswer;
}

function asStringArray(value: Prisma.JsonValue | null): string[] | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    return null;
  }
  return value;
}

function toSubmissionProjection(row: {
  id: string;
  liveSessionId: string;
  sessionQuestionId: string;
  participantId: string;
  selectedOptionRefs: Prisma.JsonValue | null;
  textAnswer: string | null;
  submittedAt: Date;
}): SubmissionProjection {
  const optionRefs = asStringArray(row.selectedOptionRefs);
  return {
    id: row.id,
    liveSessionId: row.liveSessionId,
    sessionQuestionId: row.sessionQuestionId,
    participantId: row.participantId,
    selectedOptionRefs: optionRefs,
    textAnswer: row.textAnswer,
    submittedAt: row.submittedAt,
  };
}
