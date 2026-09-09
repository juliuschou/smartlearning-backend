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

/** Build an identity-free archive from immutable snapshots and submissions. */
export function parseArchivedResult(value: unknown): ArchivedResultProjection {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.questions)
  ) {
    throw new Error('Invalid archived result payload');
  }
  const questions = value.questions.map((question) => {
    if (
      !isRecord(question) ||
      typeof question.id !== 'string' ||
      !Number.isInteger(question.position) ||
      typeof question.prompt !== 'string' ||
      !isRecord(question.result) ||
      !['poll', 'quiz', 'open_text'].includes(
        String(question.result.snapshotType),
      )
    ) {
      throw new Error('Invalid archived question payload');
    }
    return question as unknown as ArchivedQuestionProjection;
  });
  return {
    schemaVersion: 1,
    questions: [...questions].sort((a, b) => a.position - b.position),
  };
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
