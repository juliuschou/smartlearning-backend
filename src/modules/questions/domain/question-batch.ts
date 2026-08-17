import type { ErrorCode } from '../../../common/errors';
import { validateQuestion } from './question-contract';

export const BATCH_MIN_QUESTIONS = 1;
export const BATCH_MAX_QUESTIONS = 50;

/**
 * Remove the batch-only `clientRef` locator from a question payload before
 * handing it to the per-question contract validator/normalizer, which treats
 * unknown top-level fields as `FIELD_FORBIDDEN`. Shared by `validateBatch`
 * (aggregation) and the service-layer `normalizeQuestion` calls so both paths
 * strip the same field consistently.
 */
export function stripClientRef(question: unknown): Record<string, unknown> {
  if (!question || typeof question !== 'object') {
    return {};
  }
  const record = question as Record<string, unknown>;
  const { clientRef: _clientRef, ...rest } = record;
  void _clientRef;
  return rest;
}

export interface BatchQuestionInput {
  clientRef: string;
  type: string;
  prompt: string;
  selectionMode?: string;
  options?: unknown[];
  correctOptionRefs?: string[];
}

export interface BatchError {
  code: ErrorCode;
  field?: string;
  message: string;
}

export interface BatchWarning {
  code: ErrorCode;
  field?: string;
  message: string;
}

export interface BatchValidationResult {
  valid: boolean;
  errors: BatchError[];
  warnings: BatchWarning[];
  payloadHash: string;
}

/**
 * Validate a batch question payload (1–50 questions, unique clientRef, shared
 * per-question validator). Aggregates ALL recognized errors and warnings so
 * the Web/CLI surface can show them at once. Transport-independent; the
 * service layer computes the canonical payload hash.
 */
export function validateBatch(input: { questions: BatchQuestionInput[] }): {
  errors: BatchError[];
  warnings: BatchWarning[];
} {
  const errors: BatchError[] = [];
  const warnings: BatchWarning[] = [];

  if (!Array.isArray(input.questions)) {
    errors.push({
      code: 'FIELD_REQUIRED',
      field: 'questions',
      message: 'questions must be an array.',
    });
    return { errors, warnings };
  }

  if (
    input.questions.length < BATCH_MIN_QUESTIONS ||
    input.questions.length > BATCH_MAX_QUESTIONS
  ) {
    errors.push({
      code: 'BATCH_SIZE_INVALID',
      field: 'questions',
      message: `A batch must contain between ${BATCH_MIN_QUESTIONS} and ${BATCH_MAX_QUESTIONS} questions.`,
    });
  }

  const clientRefs = new Map<string, number>();
  input.questions.forEach((question, index) => {
    const prefix = `questions[${index}]`;
    if (!question || typeof question !== 'object') {
      errors.push({
        code: 'FIELD_REQUIRED',
        field: prefix,
        message: 'Question is required.',
      });
      return;
    }
    const ref = (question as { clientRef?: unknown }).clientRef;
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      errors.push({
        code: 'FIELD_REQUIRED',
        field: `${prefix}.clientRef`,
        message: 'clientRef is required.',
      });
    } else {
      const firstIndex = clientRefs.get(ref);
      if (firstIndex !== undefined) {
        errors.push({
          code: 'CLIENT_REF_DUPLICATE',
          field: `${prefix}.clientRef`,
          message: `clientRef duplicates questions[${firstIndex}].clientRef.`,
        });
      } else {
        clientRefs.set(ref, index);
      }
    }

    // Reuse the per-question validator. It does not know about clientRef (a
    // batch-only locator), so strip it before validating the question contract.
    const questionContract = stripClientRef(question);
    const issues = validateQuestion(questionContract);
    for (const issue of issues) {
      errors.push({
        code: issue.code,
        field: issue.field ? `${prefix}.${issue.field}` : prefix,
        message: issue.message,
      });
    }
  });

  return { errors, warnings };
}
