import { QuestionValidationError } from '../../../common/errors';
import type { ErrorCode } from '../../../common/errors';

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_PROMPT_LENGTH = 1_000;
export const POLL_MAX_OPTION_LENGTH = 250;
export const POLL_MAX_OPTION_REF_LENGTH = 250;

export interface PollOptionInput {
  optionRef?: string;
  text: string;
}

export interface PollSingleChoiceInput {
  type: 'poll';
  prompt: string;
  selectionMode: 'single';
  options: readonly PollOptionInput[];
}

export interface NormalizedPollOption {
  optionRef: string | null;
  text: string;
  position: number;
}

export interface NormalizedPollSingleChoice {
  type: 'poll';
  prompt: string;
  selectionMode: 'single';
  options: NormalizedPollOption[];
}

export interface QuestionValidationIssue {
  code: ErrorCode;
  field?: string;
  message: string;
}

const ALLOWED_FIELDS = new Set(['type', 'prompt', 'selectionMode', 'options']);
const ALLOWED_OPTION_FIELDS = new Set(['optionRef', 'text']);

/**
 * Validate and normalize the first supported question contract.
 *
 * The function is transport-independent so Web, CLI, and future batch paths
 * can share the same deterministic rules. It deliberately supports only
 * poll/single in this vertical slice.
 */
export function validatePollSingleChoice(
  input: unknown,
): QuestionValidationIssue[] {
  const issues: QuestionValidationIssue[] = [];
  if (!isRecord(input)) {
    return [issue('FIELD_REQUIRED', undefined, 'Question input is required.')];
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      issues.push(
        issue(
          'FIELD_FORBIDDEN',
          key,
          `Field ${key} is not allowed for this question contract.`,
        ),
      );
    }
  }

  if (input.type !== 'poll') {
    issues.push(
      issue(
        'QUESTION_TYPE_INVALID',
        'type',
        'Only poll questions are supported.',
      ),
    );
  }

  const prompt = readText(input.prompt);
  if (prompt === undefined) {
    issues.push(issue('FIELD_REQUIRED', 'prompt', 'Prompt is required.'));
  } else if (containsUnsafeText(prompt)) {
    issues.push(
      issue(
        'TEXT_UNSAFE',
        'prompt',
        'Prompt contains an unsupported character.',
      ),
    );
  } else if (prompt.length === 0) {
    issues.push(issue('TEXT_EMPTY', 'prompt', 'Prompt cannot be empty.'));
  } else if (characterLength(prompt) > POLL_MAX_PROMPT_LENGTH) {
    issues.push(
      issue(
        'TEXT_TOO_LONG',
        'prompt',
        'Prompt is longer than 1,000 characters.',
      ),
    );
  }

  if (input.selectionMode === undefined) {
    issues.push(
      issue('FIELD_REQUIRED', 'selectionMode', 'Selection mode is required.'),
    );
  } else if (input.selectionMode !== 'single') {
    issues.push(
      issue(
        'SELECTION_MODE_INVALID',
        'selectionMode',
        'This contract requires single selection mode.',
      ),
    );
  }

  const options = input.options;
  if (!Array.isArray(options)) {
    issues.push(
      issue('FIELD_REQUIRED', 'options', 'At least two options are required.'),
    );
  } else {
    if (
      options.length < POLL_MIN_OPTIONS ||
      options.length > POLL_MAX_OPTIONS
    ) {
      issues.push(
        issue(
          'OPTION_COUNT_INVALID',
          'options',
          'A poll must contain between 2 and 10 options.',
        ),
      );
    }

    const normalizedTexts = new Map<string, number>();
    const optionRefs = new Map<string, number>();
    options.forEach((rawOption, index) => {
      const field = `options[${index}]`;
      if (!isRecord(rawOption)) {
        issues.push(issue('FIELD_REQUIRED', field, 'Option is required.'));
        return;
      }

      for (const key of Object.keys(rawOption)) {
        if (!ALLOWED_OPTION_FIELDS.has(key)) {
          issues.push(
            issue(
              'FIELD_FORBIDDEN',
              `${field}.${key}`,
              `Field ${key} is not allowed on a poll option.`,
            ),
          );
        }
      }

      const text = readText(rawOption.text);
      if (text === undefined) {
        issues.push(
          issue('FIELD_REQUIRED', `${field}.text`, 'Option text is required.'),
        );
      } else if (containsUnsafeText(text)) {
        issues.push(
          issue(
            'TEXT_UNSAFE',
            `${field}.text`,
            'Option text contains an unsupported character.',
          ),
        );
      } else if (text.length === 0) {
        issues.push(
          issue('TEXT_EMPTY', `${field}.text`, 'Option text cannot be empty.'),
        );
      } else if (characterLength(text) > POLL_MAX_OPTION_LENGTH) {
        issues.push(
          issue(
            'TEXT_TOO_LONG',
            `${field}.text`,
            'Option text is longer than 250 characters.',
          ),
        );
      } else {
        const duplicateKey = duplicateKeyFor(text);
        const firstIndex = normalizedTexts.get(duplicateKey);
        if (firstIndex !== undefined) {
          issues.push(
            issue(
              'OPTION_DUPLICATE',
              `${field}.text`,
              `Option text duplicates options[${firstIndex}] after normalization.`,
            ),
          );
        } else {
          normalizedTexts.set(duplicateKey, index);
        }
      }

      if ('optionRef' in rawOption && rawOption.optionRef !== undefined) {
        const optionRef = readText(rawOption.optionRef);
        if (!optionRef) {
          issues.push(
            issue(
              'OPTION_REF_INVALID',
              `${field}.optionRef`,
              'Option ref cannot be empty.',
            ),
          );
        } else if (containsUnsafeText(optionRef)) {
          issues.push(
            issue(
              'TEXT_UNSAFE',
              `${field}.optionRef`,
              'Option ref contains an unsupported character.',
            ),
          );
        } else if (characterLength(optionRef) > POLL_MAX_OPTION_REF_LENGTH) {
          issues.push(
            issue(
              'TEXT_TOO_LONG',
              `${field}.optionRef`,
              'Option ref is longer than 250 characters.',
            ),
          );
        } else {
          const firstIndex = optionRefs.get(optionRef);
          if (firstIndex !== undefined) {
            issues.push(
              issue(
                'OPTION_REF_INVALID',
                `${field}.optionRef`,
                `Option ref duplicates options[${firstIndex}].`,
              ),
            );
          } else {
            optionRefs.set(optionRef, index);
          }
        }
      }
    });
  }

  return issues;
}

/** Validate, normalize, and throw the first stable domain error on failure. */
export function normalizePollSingleChoice(
  input: unknown,
): NormalizedPollSingleChoice {
  const issues = validatePollSingleChoice(input);
  if (issues.length > 0) {
    const first = issues[0];
    throw new QuestionValidationError(first.code, first.message, first.field);
  }

  const value = input as Record<string, unknown>;
  const options = value.options as Array<Record<string, unknown>>;
  return {
    type: 'poll',
    prompt: readText(value.prompt)!,
    selectionMode: 'single',
    options: options.map((option, index) => ({
      optionRef: readText(option.optionRef) ?? null,
      text: readText(option.text)!,
      position: index + 1,
    })),
  };
}

/** Check the poll answer boundary before persistence. */
export function validateSingleChoiceAnswer(
  selectedOptionRefs: unknown,
  validOptionRefs: readonly string[],
): QuestionValidationIssue[] {
  if (!Array.isArray(selectedOptionRefs) || selectedOptionRefs.length !== 1) {
    return [
      issue(
        'OPTION_REF_INVALID',
        'selectedOptionRefs',
        'A single-choice poll requires exactly one option.',
      ),
    ];
  }

  const selected = selectedOptionRefs[0];
  if (typeof selected !== 'string' || !validOptionRefs.includes(selected)) {
    return [
      issue(
        'OPTION_REF_INVALID',
        'selectedOptionRefs[0]',
        'Selected option does not belong to the active question.',
      ),
    ];
  }
  return [];
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(/\s+/gu, ' ').trim()
    : undefined;
}

function characterLength(value: string): number {
  return [...value].length;
}

function containsUnsafeText(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    );
  });
}

function duplicateKeyFor(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function issue(
  code: ErrorCode,
  field: string | undefined,
  message: string,
): QuestionValidationIssue {
  return { code, field, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
