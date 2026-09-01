import { QuestionValidationError } from '../../../common/errors';
import type { ErrorCode } from '../../../common/errors';
import {
  characterLength,
  containsUnsafeText,
  duplicateKeyFor,
  isRecord,
  readText,
} from './question-text';

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;
export const MAX_PROMPT_LENGTH = 1_000;
export const MAX_OPTION_LENGTH = 250;
export const MAX_OPTION_REF_LENGTH = 250;

export type QuestionType = 'poll' | 'open_text' | 'quiz';
export type PollSelectionMode = 'single' | 'multiple';

export interface QuestionOptionInput {
  optionRef?: string;
  text: string;
}

export interface NormalizedQuestionOption {
  optionRef: string | null;
  text: string;
  position: number;
}

export interface NormalizedQuestion {
  type: QuestionType;
  prompt: string;
  selectionMode: PollSelectionMode | null;
  options: NormalizedQuestionOption[];
  correctOptionRefs: string[];
}

export interface QuestionValidationIssue {
  code: ErrorCode;
  field?: string;
  message: string;
}

const ALLOWED_TOP_FIELDS = new Set([
  'type',
  'prompt',
  'selectionMode',
  'options',
  'correctOptionRefs',
]);
const ALLOWED_OPTION_FIELDS = new Set(['optionRef', 'text']);

/**
 * Validate any supported question contract (poll single/multiple, open_text,
 * quiz). Transport-independent so Web, CLI, and batch paths share rules.
 * Returns all recognized issues (the batch path surfaces them all; the
 * single-question path throws the first).
 */
export function validateQuestion(input: unknown): QuestionValidationIssue[] {
  const issues: QuestionValidationIssue[] = [];
  if (!isRecord(input)) {
    return [issue('FIELD_REQUIRED', undefined, 'Question input is required.')];
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_TOP_FIELDS.has(key)) {
      issues.push(
        issue(
          'FIELD_FORBIDDEN',
          key,
          `Field ${key} is not allowed for this question contract.`,
        ),
      );
    }
  }

  const type = input.type;
  if (type !== 'poll' && type !== 'open_text' && type !== 'quiz') {
    issues.push(
      issue(
        'QUESTION_TYPE_INVALID',
        'type',
        'Question type must be poll, open_text, or quiz.',
      ),
    );
  }

  // prompt
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
  } else if (characterLength(prompt) > MAX_PROMPT_LENGTH) {
    issues.push(
      issue(
        'TEXT_TOO_LONG',
        'prompt',
        'Prompt is longer than 1,000 characters.',
      ),
    );
  }

  // selectionMode — required for poll, forbidden for open_text/quiz
  const selectionMode = input.selectionMode;
  if (type === 'poll') {
    if (selectionMode === undefined) {
      issues.push(
        issue('FIELD_REQUIRED', 'selectionMode', 'Selection mode is required.'),
      );
    } else if (selectionMode !== 'single' && selectionMode !== 'multiple') {
      issues.push(
        issue(
          'SELECTION_MODE_INVALID',
          'selectionMode',
          'Poll selectionMode must be single or multiple.',
        ),
      );
    }
  } else if (selectionMode !== undefined) {
    issues.push(
      issue(
        'FIELD_FORBIDDEN',
        'selectionMode',
        'selectionMode is not allowed for this question type.',
      ),
    );
  }

  // options — required for poll/quiz, forbidden for open_text
  const options = input.options;
  if (type === 'open_text') {
    if (options !== undefined) {
      issues.push(
        issue(
          'FIELD_FORBIDDEN',
          'options',
          'options are not allowed for open_text questions.',
        ),
      );
    }
  } else if (type === 'poll' || type === 'quiz') {
    if (!Array.isArray(options)) {
      issues.push(
        issue(
          'FIELD_REQUIRED',
          'options',
          'At least two options are required.',
        ),
      );
    } else {
      validateOptions(options, issues);
    }
  }

  // correctOptionRefs — required for quiz, forbidden for poll/open_text
  const correctOptionRefs = input.correctOptionRefs;
  if (type === 'quiz') {
    if (correctOptionRefs === undefined) {
      issues.push(
        issue(
          'FIELD_REQUIRED',
          'correctOptionRefs',
          'Quiz questions require at least one correct option reference.',
        ),
      );
    } else if (
      !Array.isArray(correctOptionRefs) ||
      correctOptionRefs.length === 0
    ) {
      issues.push(
        issue(
          'CORRECT_OPTION_INVALID',
          'correctOptionRefs',
          'Quiz questions require at least one correct option reference.',
        ),
      );
    } else if (Array.isArray(options)) {
      validateCorrectOptionRefs(correctOptionRefs, options, issues);
    }
  } else if (correctOptionRefs !== undefined) {
    issues.push(
      issue(
        'FIELD_FORBIDDEN',
        'correctOptionRefs',
        'correctOptionRefs is not allowed for this question type.',
      ),
    );
  }

  return issues;
}

function validateOptions(
  options: unknown[],
  issues: QuestionValidationIssue[],
): void {
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    issues.push(
      issue(
        'OPTION_COUNT_INVALID',
        'options',
        'A question must contain between 2 and 10 options.',
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
            `Field ${key} is not allowed on an option.`,
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
    } else if (characterLength(text) > MAX_OPTION_LENGTH) {
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
      } else if (characterLength(optionRef) > MAX_OPTION_REF_LENGTH) {
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

function validateCorrectOptionRefs(
  correctOptionRefs: unknown[],
  options: unknown[],
  issues: QuestionValidationIssue[],
): void {
  const validRefs = new Set<string>();
  for (const raw of options) {
    if (isRecord(raw)) {
      const ref = readText(raw.optionRef);
      if (ref) validRefs.add(ref);
    }
  }
  const seen = new Set<string>();
  correctOptionRefs.forEach((raw, index) => {
    const ref = readText(raw);
    if (!ref) {
      issues.push(
        issue(
          'CORRECT_OPTION_INVALID',
          `correctOptionRefs[${index}]`,
          'Correct option reference cannot be empty.',
        ),
      );
      return;
    }
    if (seen.has(ref)) {
      issues.push(
        issue(
          'CORRECT_OPTION_INVALID',
          `correctOptionRefs[${index}]`,
          'Correct option references must be unique.',
        ),
      );
      return;
    }
    seen.add(ref);
    if (!validRefs.has(ref)) {
      issues.push(
        issue(
          'CORRECT_OPTION_INVALID',
          `correctOptionRefs[${index}]`,
          'Correct option reference does not match any option.',
        ),
      );
    }
  });
}

/** Validate, normalize, and throw the first stable domain error on failure. */
export function normalizeQuestion(input: unknown): NormalizedQuestion {
  const issues = validateQuestion(input);
  if (issues.length > 0) {
    const first = issues[0];
    throw new QuestionValidationError(first.code, first.message, first.field);
  }

  const value = input as Record<string, unknown>;
  const type = value.type as QuestionType;
  const prompt = readText(value.prompt)!;

  if (type === 'open_text') {
    return {
      type,
      prompt,
      selectionMode: null,
      options: [],
      correctOptionRefs: [],
    };
  }

  const options = value.options as Array<Record<string, unknown>>;
  const normalizedOptions: NormalizedQuestionOption[] = options.map(
    (option, index) => ({
      optionRef: readText(option.optionRef) ?? null,
      text: readText(option.text)!,
      position: index + 1,
    }),
  );

  if (type === 'poll') {
    return {
      type,
      prompt,
      selectionMode: value.selectionMode as PollSelectionMode,
      options: normalizedOptions,
      correctOptionRefs: [],
    };
  }

  // quiz
  const correctOptionRefs = (value.correctOptionRefs as unknown[])
    .map((raw) => readText(raw)!)
    .filter(Boolean);
  return {
    type,
    prompt,
    selectionMode: null,
    options: normalizedOptions,
    correctOptionRefs,
  };
}

function issue(
  code: ErrorCode,
  field: string | undefined,
  message: string,
): QuestionValidationIssue {
  return { code, field, message };
}
