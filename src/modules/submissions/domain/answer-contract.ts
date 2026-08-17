import { QuestionValidationError } from '../../../common/errors';
import type { ErrorCode } from '../../../common/errors';
import {
  characterLength,
  containsUnsafeText,
} from '../../questions/domain/question-text';
import type {
  QuestionType,
  PollSelectionMode,
} from '../../questions/domain/question-contract';

/**
 * Runtime answer validation shared by the submission path. Branches on the
 * `SessionQuestion` snapshot type/selection mode so poll single/multiple, quiz,
 * and open_text answers are all enforced at the application boundary.
 *
 * The validator operates on canonical formal option UUIDs (the caller resolves
 * wire-level optionRefs to snapshot option IDs before calling). Exact-set quiz
 * scoring remains a results-aggregation concern; here we only guard that the
 * selected refs are a legal, duplicate-free subset of the snapshot options with
 * the right cardinality for the question type.
 */

export interface AnswerValidationIssue {
  code: ErrorCode;
  field?: string;
  message: string;
}

export interface AnswerSnapshotOption {
  id: string;
  isCorrect: boolean;
}

export interface AnswerContractInput {
  snapshotType: QuestionType;
  snapshotSelectionMode: PollSelectionMode | null;
  options: readonly AnswerSnapshotOption[];
  selectedOptionRefs: readonly string[] | null;
  textAnswer: string | null;
}

export const MAX_TEXT_ANSWER_LENGTH = 2_000;

/** Validate, normalize, and throw the first stable domain error on failure. */
export function validateAnswer(
  input: AnswerContractInput,
): AnswerValidationIssue[] {
  const issues: AnswerValidationIssue[] = [];

  if (input.snapshotType === 'open_text') {
    validateOpenTextAnswer(input, issues);
    return issues;
  }

  // Option-bearing types (poll, quiz). open_text must not carry selected refs.
  validateOptionAnswer(input, issues);
  return issues;
}

function validateOpenTextAnswer(
  input: AnswerContractInput,
  issues: AnswerValidationIssue[],
): void {
  if (
    input.selectedOptionRefs !== null &&
    input.selectedOptionRefs.length > 0
  ) {
    issues.push(
      issue(
        'FIELD_FORBIDDEN',
        'selectedOptionRefs',
        'selectedOptionRefs is not allowed for an open_text answer.',
      ),
    );
  }
  const text = input.textAnswer;
  if (text === null || text.length === 0) {
    issues.push(
      issue('FIELD_REQUIRED', 'textAnswer', 'An open_text answer is required.'),
    );
    return;
  }
  if (containsUnsafeText(text)) {
    issues.push(
      issue(
        'TEXT_UNSAFE',
        'textAnswer',
        'Answer text contains an unsupported character.',
      ),
    );
  } else if (characterLength(text) > MAX_TEXT_ANSWER_LENGTH) {
    issues.push(
      issue(
        'TEXT_TOO_LONG',
        'textAnswer',
        'Answer text is longer than 2,000 characters.',
      ),
    );
  }
}

function validateOptionAnswer(
  input: AnswerContractInput,
  issues: AnswerValidationIssue[],
): void {
  if (input.textAnswer !== null && input.textAnswer.length > 0) {
    issues.push(
      issue(
        'FIELD_FORBIDDEN',
        'textAnswer',
        'textAnswer is not allowed for an option answer.',
      ),
    );
  }

  const refs = input.selectedOptionRefs ?? [];
  if (refs.length === 0) {
    issues.push(
      issue(
        'FIELD_REQUIRED',
        'selectedOptionRefs',
        'At least one selected option is required.',
      ),
    );
    return;
  }

  const validIds = new Set(input.options.map((option) => option.id));

  // Duplicate detection (set semantics for multiple/quiz exact-set scoring).
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) {
      issues.push(
        issue(
          'OPTION_REF_INVALID',
          'selectedOptionRefs',
          'Selected options must be unique.',
        ),
      );
      return;
    }
    seen.add(ref);
  }

  // Membership: every ref must be a snapshot option id.
  for (const ref of refs) {
    if (!validIds.has(ref)) {
      issues.push(
        issue(
          'OPTION_REF_INVALID',
          'selectedOptionRefs',
          'A selected option does not belong to the active question.',
        ),
      );
      return;
    }
  }

  // Cardinality by type/mode.
  const maxSelectable = input.options.length;
  if (input.snapshotType === 'poll') {
    if (input.snapshotSelectionMode === 'single' && refs.length !== 1) {
      issues.push(
        issue(
          'OPTION_REF_INVALID',
          'selectedOptionRefs',
          'A single-choice poll requires exactly one option.',
        ),
      );
    } else if (input.snapshotSelectionMode === 'multiple') {
      if (refs.length > maxSelectable) {
        issues.push(
          issue(
            'OPTION_REF_INVALID',
            'selectedOptionRefs',
            'Selected options exceed the available options.',
          ),
        );
      }
    }
  } else if (input.snapshotType === 'quiz') {
    const correctCount = input.options.filter(
      (option) => option.isCorrect,
    ).length;
    // Single correct => single-answer; multiple correct => 1..N (any subset).
    // Exact-set scoring is handled by results aggregation.
    if (refs.length > maxSelectable) {
      issues.push(
        issue(
          'OPTION_REF_INVALID',
          'selectedOptionRefs',
          'Selected options exceed the available options.',
        ),
      );
    }
    if (correctCount === 1 && refs.length !== 1) {
      issues.push(
        issue(
          'OPTION_REF_INVALID',
          'selectedOptionRefs',
          'This quiz question requires exactly one option.',
        ),
      );
    }
  }
}

/** Normalize an open-text answer (NFC, whitespace collapse, trim). */
export function normalizeTextAnswer(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Sort canonical refs into a stable order for idempotency fingerprinting. */
export function canonicalRefFingerprint(refs: readonly string[]): string[] {
  return [...refs].sort();
}

/** Throw the first issue as a stable domain error (400). */
export function throwOnAnswerIssues(
  issues: readonly AnswerValidationIssue[],
): void {
  if (issues.length > 0) {
    const first = issues[0];
    throw new QuestionValidationError(first.code, first.message, first.field);
  }
}

function issue(
  code: ErrorCode,
  field: string | undefined,
  message: string,
): AnswerValidationIssue {
  return { code, field, message };
}
