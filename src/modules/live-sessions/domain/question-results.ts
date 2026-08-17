import type {
  OpenTextResultsDto,
  OptionCountDto,
  PollResultsDto,
  QuizResultsDto,
  SessionQuestionResultsDto,
} from '../api/dto';

/**
 * Pure aggregation of committed Submission rows into a results projection.
 *
 * No Prisma, no I/O. The caller loads SessionQuestion + options + submissions
 * and passes them in. `revealCorrectness` controls whether quiz `isCorrect` is
 * exposed: teacher always; participant only after the question is closed
 * (vote-to-reveal, US-F17).
 *
 * Authority: M2 即時同步與結果治理設計 — aggregate is a logical projection of
 * immutable SessionQuestion/Submission rows, never an independent authority.
 */

export interface AggregateOptionInput {
  id: string;
  optionRef: string | null;
  text: string;
  isCorrect: boolean;
}

export interface AggregateSubmissionInput {
  selectedOptionRefs: string[] | null;
  textAnswer: string | null;
}

export interface AggregateResultsInput {
  snapshotType: string;
  selectionMode: string | null;
  status: string;
  options: AggregateOptionInput[];
  submissions: AggregateSubmissionInput[];
  revealCorrectness: boolean;
}

/**
 * Count selections per option. A submission contributes one count to each of
 * its selected formal option UUIDs. Unknown option UUIDs are ignored
 * defensively (submit canonicalizes, so this should never happen, but the
 * projection must not crash on stale/unknown refs).
 */
function countOptionSelections(
  options: AggregateOptionInput[],
  submissions: AggregateSubmissionInput[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const option of options) counts.set(option.id, 0);
  for (const submission of submissions) {
    const refs = submission.selectedOptionRefs;
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (counts.has(ref)) counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
  }
  return counts;
}

function buildOptionCounts(
  options: AggregateOptionInput[],
  counts: Map<string, number>,
  includeIsCorrect: boolean,
): OptionCountDto[] {
  return options.map((option) => {
    const dto: OptionCountDto = {
      optionId: option.id,
      optionRef: option.optionRef,
      text: option.text,
      count: counts.get(option.id) ?? 0,
    };
    if (includeIsCorrect) dto.isCorrect = option.isCorrect;
    return dto;
  });
}

function aggregatePoll(input: AggregateResultsInput): PollResultsDto {
  const counts = countOptionSelections(input.options, input.submissions);
  return {
    snapshotType: 'poll',
    selectionMode: input.selectionMode as 'single' | 'multiple',
    status: input.status as 'open' | 'closed',
    options: buildOptionCounts(input.options, counts, false),
    totalResponses: input.submissions.length,
  };
}

function aggregateQuiz(input: AggregateResultsInput): QuizResultsDto {
  const counts = countOptionSelections(input.options, input.submissions);
  const totalResponses = input.submissions.length;
  const base: QuizResultsDto = {
    snapshotType: 'quiz',
    status: input.status as 'open' | 'closed',
    options: buildOptionCounts(input.options, counts, input.revealCorrectness),
    totalResponses,
  };
  // Correctness metrics (counts + rate) are hidden until correctness is
  // revealed (teacher always; participant only after close). This prevents a
  // participant who has already submitted from inferring the answer during the
  // open window — option-level isCorrect is already gated, the aggregate
  // correctCount/rate must be gated too.
  if (!input.revealCorrectness) return base;
  const correctOptionIds = new Set(
    input.options.filter((o) => o.isCorrect).map((o) => o.id),
  );
  let correctCount = 0;
  for (const submission of input.submissions) {
    const refs = submission.selectedOptionRefs ?? [];
    // Exact-set match: the submitted set must equal the correct-option set.
    const selectedSet = new Set(refs);
    if (selectedSet.size !== correctOptionIds.size) continue;
    let matches = true;
    for (const id of selectedSet) {
      if (!correctOptionIds.has(id)) {
        matches = false;
        break;
      }
    }
    if (matches) correctCount += 1;
  }
  return {
    ...base,
    correctCount,
    incorrectCount: totalResponses - correctCount,
    correctnessRate: totalResponses === 0 ? 0 : correctCount / totalResponses,
  };
}

function aggregateOpenText(input: AggregateResultsInput): OpenTextResultsDto {
  return {
    snapshotType: 'open_text',
    status: input.status as 'open' | 'closed',
    responses: input.submissions
      .map((submission) => submission.textAnswer)
      .filter((text): text is string => typeof text === 'string')
      .map((text) => ({ text })),
    totalResponses: input.submissions.length,
  };
}

export function aggregateResults(
  input: AggregateResultsInput,
): SessionQuestionResultsDto {
  switch (input.snapshotType) {
    case 'poll':
      return aggregatePoll(input);
    case 'quiz':
      return aggregateQuiz(input);
    case 'open_text':
      return aggregateOpenText(input);
    default:
      throw new Error(
        `Unsupported snapshotType for results aggregation: ${input.snapshotType}`,
      );
  }
}
