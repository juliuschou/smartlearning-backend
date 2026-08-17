import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../../generated/prisma/client';
import {
  generateToken,
  hashToken,
  hashPayload,
  isUuid,
  newId,
  normalizeUuid,
} from '../../../common/crypto';
import {
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import {
  normalizeQuestion,
  type NormalizedQuestion,
} from '../domain/question-contract';
import { validateBatch, stripClientRef } from '../domain/question-batch';
import { QuestionService, toQuestionDto } from './question.service';

export const VALIDATION_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const BATCH_OPERATION = 'question-batch-confirm';

/** Unified caller principal for batch operations (Web or CLI). */
export interface BatchCaller {
  kind: 'web' | 'cli';
  accountId: string;
  role: string;
  cliCredentialId?: string;
}

export interface ValidateBatchResult {
  schemaVersion: number;
  valid: boolean;
  payloadHash: string;
  errors: { code: string; field?: string; message: string }[];
  warnings: { code: string; field?: string; message: string }[];
  preview: unknown[] | null;
  validationToken: string | null;
  expiresAt: string | null;
}

export interface ConfirmBatchResult {
  schemaVersion: number;
  payloadHash: string;
  questions: unknown[];
}

@Injectable()
export class QuestionBatchService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly transactions: TransactionService,
    private readonly questions: QuestionService,
  ) {}

  private get db() {
    return this.prismaService.prisma;
  }

  /**
   * Validate a batch payload. On success, issue an opaque DB-backed validation
   * token (hash only) bound to actor/course/payload hash, 15m expiry, and
   * return a preview + the raw token (once). On failure, return all errors/
   * warnings with token=null.
   */
  async validateBatch(
    courseId: string,
    caller: BatchCaller,
    input: { schemaVersion: number; questions: unknown[] },
  ): Promise<ValidateBatchResult> {
    const canonicalCourseId = normalizeUuid(courseId);
    const course = await this.db.course.findUnique({
      where: { id: canonicalCourseId },
    });
    if (
      !course ||
      (course.ownerAccountId !== caller.accountId && caller.role !== 'admin')
    ) {
      throw new NotFoundError('Course not found', 'courseId');
    }
    if (course.status !== 'draft') {
      throw new DomainError(
        'COURSE_NOT_EDITABLE',
        'Course is not editable.',
        409,
        'courseId',
        'Use a draft Course before batch authoring.',
      );
    }

    const payloadHash = hashPayload(input.questions);
    const { errors, warnings } = validateBatch({
      questions: input.questions as never,
    });
    const valid = errors.length === 0;

    if (!valid) {
      return {
        schemaVersion: input.schemaVersion,
        valid: false,
        payloadHash,
        errors,
        warnings,
        preview: null,
        validationToken: null,
        expiresAt: null,
      };
    }

    const normalized = (input.questions as unknown[]).map((q) =>
      normalizeQuestion(stripClientRef(q)),
    );
    const preview = normalized.map((q) => this.toPreview(q));

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + VALIDATION_TOKEN_LIFETIME_MS);
    await this.db.questionValidationToken.create({
      data: {
        id: newId(),
        tokenHash,
        accountId: caller.accountId,
        cliCredentialId: caller.cliCredentialId ?? null,
        courseId: canonicalCourseId,
        payloadHash,
        schemaVersion: input.schemaVersion,
        expiresAt,
      },
    });

    return {
      schemaVersion: input.schemaVersion,
      valid: true,
      payloadHash,
      errors,
      warnings,
      preview,
      validationToken: rawToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Confirm a batch: recheck idempotency, token, course state, then append
   * all questions atomically (all-or-nothing). Consumes the token on success
   * only; a failed transaction does not consume it (M2 紅卡).
   */
  async confirmBatch(
    courseId: string,
    caller: BatchCaller,
    input: {
      schemaVersion: number;
      questions: unknown[];
      payloadHash: string;
      confirmed: true;
    },
    rawToken: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<ConfirmBatchResult> {
    const canonicalCourseId = normalizeUuid(courseId);
    if (!idempotencyKey || !isUuid(idempotencyKey)) {
      throw new ValidationError(
        'A UUID Idempotency-Key is required.',
        'Idempotency-Key',
      );
    }
    const canonicalIdempotencyKey = normalizeUuid(idempotencyKey);
    if (!rawToken) {
      throw new DomainError(
        'VALIDATION_TOKEN_INVALID',
        'Validation token is required.',
        409,
        'X-Validation-Token',
        'Provide the validation token from the validate response.',
      );
    }

    const computedHash = hashPayload(input.questions);
    if (computedHash !== input.payloadHash) {
      throw new DomainError(
        'PAYLOAD_HASH_MISMATCH',
        'payloadHash does not match the submitted questions.',
        409,
        'payloadHash',
        'Re-validate the batch and submit the matching payload hash.',
      );
    }

    const actorScope =
      caller.kind === 'cli'
        ? `cli:${caller.cliCredentialId}`
        : `web:${caller.accountId}`;
    const idempotencyLockKey = `qbatch:${actorScope}:${canonicalIdempotencyKey}`;

    return this.transactions.run(async (tx) => {
      await this.transactions.lockAdvisoryKey(tx, idempotencyLockKey);

      // Idempotency replay / conflict.
      const existing = await tx.questionBatchIdempotency.findUnique({
        where: {
          actorScope_operation_idempotencyKey: {
            actorScope,
            operation: BATCH_OPERATION,
            idempotencyKey: canonicalIdempotencyKey,
          },
        },
      });
      if (existing) {
        if (existing.payloadHash !== computedHash) {
          throw new DomainError(
            'IDEMPOTENCY_KEY_CONFLICT',
            'Idempotency-Key is already bound to a different payload.',
            409,
            'Idempotency-Key',
            'Retry with the original payload or use a new key for a new batch.',
          );
        }
        return {
          schemaVersion: input.schemaVersion,
          payloadHash: existing.payloadHash,
          questions:
            (existing.responseJson as { questions?: unknown[] }).questions ??
            [],
        };
      }

      // Token validation.
      const tokenHash = hashToken(rawToken);
      const token = await tx.questionValidationToken.findUnique({
        where: { tokenHash },
      });
      if (!token) {
        throw new DomainError(
          'VALIDATION_TOKEN_INVALID',
          'Validation token is invalid.',
          409,
          'X-Validation-Token',
          'Re-validate the batch to obtain a new token.',
        );
      }
      if (token.consumedAt) {
        throw new DomainError(
          'VALIDATION_TOKEN_CONSUMED',
          'Validation token has already been used.',
          409,
          'X-Validation-Token',
          'Re-validate the batch to obtain a new token.',
        );
      }
      if (token.expiresAt.getTime() <= Date.now()) {
        throw new DomainError(
          'VALIDATION_TOKEN_EXPIRED',
          'Validation token has expired.',
          409,
          'X-Validation-Token',
          'Re-validate the batch to obtain a new token.',
        );
      }
      if (token.payloadHash !== computedHash) {
        throw new DomainError(
          'PAYLOAD_HASH_MISMATCH',
          'Validation token does not match the submitted payload.',
          409,
          'payloadHash',
          'Re-validate the batch and submit the matching payload.',
        );
      }
      if (token.accountId !== caller.accountId) {
        throw new DomainError(
          'VALIDATION_TOKEN_INVALID',
          'Validation token does not belong to this actor.',
          409,
          'X-Validation-Token',
          'Re-validate the batch as the correct actor.',
        );
      }
      if (token.courseId !== canonicalCourseId) {
        throw new DomainError(
          'VALIDATION_TOKEN_INVALID',
          'Validation token is not for this course.',
          409,
          'X-Validation-Token',
          'Re-validate the batch for the correct course.',
        );
      }
      if (
        caller.kind === 'cli' &&
        token.cliCredentialId !== caller.cliCredentialId
      ) {
        throw new DomainError(
          'VALIDATION_TOKEN_INVALID',
          'Validation token is not bound to this CLI credential.',
          409,
          'X-Validation-Token',
          'Re-validate the batch with the matching CLI credential.',
        );
      }

      // Normalize all questions (throws on first invalid → rollback all).
      const normalized = (input.questions as unknown[]).map((q) =>
        normalizeQuestion(stripClientRef(q)),
      );

      // Append all-or-nothing via QuestionService within this transaction.
      const created = await this.questions.appendBatchInTransaction(
        tx,
        canonicalCourseId,
        { id: caller.accountId, role: caller.role },
        normalized,
      );

      const response = {
        schemaVersion: input.schemaVersion,
        payloadHash: computedHash,
        questions: created.map((q) => toQuestionDto(q)),
      };

      // Consume token + persist idempotency record.
      await tx.questionValidationToken.update({
        where: { id: token.id },
        data: { consumedAt: new Date() },
      });
      await tx.questionBatchIdempotency.create({
        data: {
          id: newId(),
          actorScope,
          operation: BATCH_OPERATION,
          idempotencyKey: canonicalIdempotencyKey,
          payloadHash: computedHash,
          responseJson: response as unknown as Prisma.InputJsonValue,
        },
      });

      return response;
    });
  }

  /** Build the preview projection for a normalized question. */
  private toPreview(q: NormalizedQuestion): unknown {
    return {
      type: q.type,
      prompt: q.prompt,
      selectionMode: q.selectionMode,
      options: q.options.map((o) => ({
        optionRef: o.optionRef,
        text: o.text,
        position: o.position,
      })),
      correctOptionRefs: q.correctOptionRefs,
    };
  }
}
