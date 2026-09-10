import {
  aggregateResults,
  type AggregateOptionInput,
  type AggregateSubmissionInput,
} from '../../live-sessions/domain/question-results';
import type { SessionQuestionResultsDto } from '../../live-sessions/api/dto';

export interface ArchiveQuestionInput {
  id: string;
  position: number;
  snapshotType: string;
  snapshotPrompt: string;
  snapshotSelectionMode: string | null;
  options: Array<AggregateOptionInput & { position: number }>;
  submissions: AggregateSubmissionInput[];
}

export interface ArchivedQuestionProjection {
  id: string;
  position: number;
  prompt: string;
  result: SessionQuestionResultsDto;
}

export interface ArchivedResultProjection {
  schemaVersion: 1;
  questions: ArchivedQuestionProjection[];
}

/** Parse persisted archive JSON into the strict identity-free wire projection. */
export function parseArchivedResult(value: unknown): ArchivedResultProjection {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.questions)
  ) {
    throw new Error('Invalid archived result payload');
  }

  return {
    schemaVersion: 1,
    questions: value.questions
      .map(parseArchivedQuestion)
      .sort((a, b) => a.position - b.position),
  };
}

function parseArchivedQuestion(value: unknown): ArchivedQuestionProjection {
  if (!isRecord(value)) throw new Error('Invalid archived question payload');

  return {
    id: requireString(value.id, 'Invalid archived question payload'),
    position: requireInteger(
      value.position,
      'Invalid archived question payload',
      1,
    ),
    prompt: requireString(value.prompt, 'Invalid archived question payload'),
    result: parseArchivedQuestionResult(value.result),
  };
}

function parseArchivedQuestionResult(
  value: unknown,
): SessionQuestionResultsDto {
  if (!isRecord(value) || value.status !== 'closed') {
    throw new Error('Invalid archived question result');
  }

  if (value.snapshotType === 'poll') {
    if (
      !['single', 'multiple'].includes(String(value.selectionMode)) ||
      !Array.isArray(value.options)
    ) {
      throw new Error('Invalid archived poll result');
    }
    return {
      snapshotType: 'poll',
      selectionMode: value.selectionMode as 'single' | 'multiple',
      status: 'closed',
      options: value.options.map((option) => parseOptionCount(option, false)),
      totalResponses: requireInteger(
        value.totalResponses,
        'Invalid archived poll result',
      ),
    };
  }

  if (value.snapshotType === 'quiz') {
    if (!Array.isArray(value.options)) {
      throw new Error('Invalid archived quiz result');
    }
    return {
      snapshotType: 'quiz',
      status: 'closed',
      options: value.options.map((option) => parseOptionCount(option, true)),
      totalResponses: requireInteger(
        value.totalResponses,
        'Invalid archived quiz result',
      ),
      correctCount: requireInteger(
        value.correctCount,
        'Invalid archived quiz result',
      ),
      incorrectCount: requireInteger(
        value.incorrectCount,
        'Invalid archived quiz result',
      ),
      correctnessRate: requireRate(
        value.correctnessRate,
        'Invalid archived quiz result',
      ),
    };
  }

  if (value.snapshotType === 'open_text') {
    if (!Array.isArray(value.responses)) {
      throw new Error('Invalid archived open-text result');
    }
    return {
      snapshotType: 'open_text',
      status: 'closed',
      responses: value.responses.map(parseOpenTextResponse),
      totalResponses: requireInteger(
        value.totalResponses,
        'Invalid archived open-text result',
      ),
    };
  }

  throw new Error('Invalid archived question result');
}

function parseOptionCount(value: unknown, quiz: boolean) {
  if (!isRecord(value)) throw new Error('Invalid archived option result');
  const optionRef = value.optionRef;
  if (optionRef !== null && typeof optionRef !== 'string') {
    throw new Error('Invalid archived option result');
  }

  const parsed = {
    optionId: requireString(value.optionId, 'Invalid archived option result'),
    optionRef,
    text: requireString(value.text, 'Invalid archived option result'),
    count: requireInteger(value.count, 'Invalid archived option result'),
  };
  if (!quiz) return parsed;
  if (typeof value.isCorrect !== 'boolean') {
    throw new Error('Invalid archived quiz option');
  }
  return { ...parsed, isCorrect: value.isCorrect };
}

function parseOpenTextResponse(value: unknown) {
  if (!isRecord(value)) throw new Error('Invalid archived open-text response');
  return {
    text: requireString(value.text, 'Invalid archived open-text response'),
  };
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  return value;
}

function requireInteger(value: unknown, message: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(message);
  }
  return value as number;
}

function requireRate(value: unknown, message: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(message);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function projectArchive(
  questions: ArchiveQuestionInput[],
): ArchivedResultProjection {
  return {
    schemaVersion: 1,
    questions: [...questions]
      .sort((a, b) => a.position - b.position)
      .map((question) => ({
        id: question.id,
        position: question.position,
        prompt: question.snapshotPrompt,
        result: aggregateResults({
          snapshotType: question.snapshotType,
          selectionMode: question.snapshotSelectionMode,
          status: 'closed',
          options: [...question.options].sort(
            (a, b) => a.position - b.position,
          ),
          submissions: question.submissions,
          revealCorrectness: true,
        }),
      })),
  };
}
