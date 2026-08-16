import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { isUuid, newId, normalizeUuid } from '../../../common/crypto';
import {
  ConflictError,
  DomainError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../../common/errors';
import { TransactionService } from '../../../prisma/transaction.service';
import { validateSingleChoiceAnswer } from '../../questions/domain/poll-single-choice';
import {
  LiveSessionStatus,
  SessionQuestionStatus,
} from '../../live-sessions/domain';
import type { ParticipantContext } from '../../participants/application/participant.service';
import type { CreateSubmissionDto } from '../api/dto';

export interface SubmissionProjection {
  id: string;
  liveSessionId: string;
  sessionQuestionId: string;
  participantId: string;
  selectedOptionRefs: string[];
  submittedAt: Date;
}

@Injectable()
export class SubmissionService {
  constructor(private readonly transactions: TransactionService) {}

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
    const selectedOptionRefs = dto.selectedOptionRefs.map(
      normalizeSubmissionRef,
    );

    return this.transactions.run(async (tx) => {
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
          )
        ) {
          return toSubmissionProjection(existingByKey);
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

      const answerIssues = validateSingleChoiceAnswer(
        canonicalSelectedOptionRefs,
        [...optionIdsByFormalId.values()],
      );
      if (answerIssues.length > 0) {
        const first = answerIssues[0];
        throw new DomainError(first.code, first.message, 400, first.field);
      }

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

      try {
        const created = await tx.submission.create({
          data: {
            id: newId(),
            liveSessionId: canonicalLiveSessionId,
            sessionQuestionId: question.id,
            participantId: canonicalParticipantId,
            idempotencyKey: canonicalIdempotencyKey,
            selectedOptionRefs: canonicalSelectedOptionRefs,
            textAnswer: null,
          },
        });
        return toSubmissionProjection(created);
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
  },
  participantId: string,
  sessionQuestionId: string,
  selectedOptionRefs: readonly string[],
): boolean {
  return (
    existing.participantId === participantId &&
    existing.sessionQuestionId === sessionQuestionId &&
    JSON.stringify(existing.selectedOptionRefs) ===
      JSON.stringify(selectedOptionRefs)
  );
}

function toSubmissionProjection(row: {
  id: string;
  liveSessionId: string;
  sessionQuestionId: string;
  participantId: string;
  selectedOptionRefs: Prisma.JsonValue | null;
  submittedAt: Date;
}): SubmissionProjection {
  const selectedOptionRefs = row.selectedOptionRefs;
  if (
    !Array.isArray(selectedOptionRefs) ||
    !selectedOptionRefs.every((value) => typeof value === 'string')
  ) {
    throw new Error(
      'Persisted poll submission has an invalid option projection.',
    );
  }
  return {
    id: row.id,
    liveSessionId: row.liveSessionId,
    sessionQuestionId: row.sessionQuestionId,
    participantId: row.participantId,
    selectedOptionRefs,
    submittedAt: row.submittedAt,
  };
}
