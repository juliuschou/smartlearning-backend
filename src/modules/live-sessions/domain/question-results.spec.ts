import {
  aggregateResults,
  type AggregateResultsInput,
} from './question-results';
import type {
  OpenTextResultsDto,
  PollResultsDto,
  QuizResultsDto,
} from '../api/dto';

const OPT = (
  id: string,
  optionRef: string | null,
  text: string,
  isCorrect = false,
) => ({ id, optionRef, text, isCorrect });

const baseInput = (
  overrides: Partial<AggregateResultsInput>,
): AggregateResultsInput => ({
  snapshotType: 'poll',
  selectionMode: 'single',
  status: 'closed',
  options: [],
  submissions: [],
  revealCorrectness: false,
  ...overrides,
});

/** Narrow the union to a poll result. */
const asPoll = (r: ReturnType<typeof aggregateResults>): PollResultsDto =>
  r as PollResultsDto;
const asQuiz = (r: ReturnType<typeof aggregateResults>): QuizResultsDto =>
  r as QuizResultsDto;
const asOpenText = (
  r: ReturnType<typeof aggregateResults>,
): OpenTextResultsDto => r as OpenTextResultsDto;

describe('aggregateResults', () => {
  describe('poll single', () => {
    it('counts per option and totalResponses equals submission count', () => {
      const result = asPoll(
        aggregateResults(
          baseInput({
            snapshotType: 'poll',
            selectionMode: 'single',
            options: [OPT('a', 'a', 'A'), OPT('b', 'b', 'B')],
            submissions: [
              { selectedOptionRefs: ['a'], textAnswer: null },
              { selectedOptionRefs: ['a'], textAnswer: null },
              { selectedOptionRefs: ['b'], textAnswer: null },
            ],
          }),
        ),
      );
      expect(result).toEqual({
        snapshotType: 'poll',
        selectionMode: 'single',
        status: 'closed',
        options: [
          { optionId: 'a', optionRef: 'a', text: 'A', count: 2 },
          { optionId: 'b', optionRef: 'b', text: 'B', count: 1 },
        ],
        totalResponses: 3,
      });
    });

    it('never exposes isCorrect for poll', () => {
      const result = asPoll(
        aggregateResults(
          baseInput({
            snapshotType: 'poll',
            selectionMode: 'single',
            options: [OPT('a', 'a', 'A', true)],
            submissions: [{ selectedOptionRefs: ['a'], textAnswer: null }],
            revealCorrectness: true,
          }),
        ),
      );
      expect(result.options[0].isCorrect).toBeUndefined();
    });
  });

  describe('poll multiple', () => {
    it('sum of counts can exceed totalResponses', () => {
      const result = asPoll(
        aggregateResults(
          baseInput({
            snapshotType: 'poll',
            selectionMode: 'multiple',
            options: [
              OPT('a', 'a', 'A'),
              OPT('b', 'b', 'B'),
              OPT('c', 'c', 'C'),
            ],
            submissions: [
              { selectedOptionRefs: ['a', 'b'], textAnswer: null },
              { selectedOptionRefs: ['a'], textAnswer: null },
            ],
          }),
        ),
      );
      expect(result.options.map((o) => o.count)).toEqual([2, 1, 0]);
      expect(result.totalResponses).toBe(2);
    });
  });

  describe('quiz', () => {
    it('marks correctCount by exact-set match (single correct)', () => {
      const result = asQuiz(
        aggregateResults(
          baseInput({
            snapshotType: 'quiz',
            options: [OPT('a', 'a', 'A', true), OPT('b', 'b', 'B', false)],
            submissions: [
              { selectedOptionRefs: ['a'], textAnswer: null }, // correct
              { selectedOptionRefs: ['b'], textAnswer: null }, // incorrect
            ],
            revealCorrectness: true,
          }),
        ),
      );
      expect(result.correctCount).toBe(1);
      expect(result.incorrectCount).toBe(1);
      expect(result.correctnessRate).toBe(0.5);
      expect(result.totalResponses).toBe(2);
      expect(result.options.map((o) => o.isCorrect)).toEqual([true, false]);
    });

    it('marks correctCount by exact-set match (multiple correct)', () => {
      const result = asQuiz(
        aggregateResults(
          baseInput({
            snapshotType: 'quiz',
            options: [
              OPT('a', 'a', 'A', true),
              OPT('b', 'b', 'B', true),
              OPT('c', 'c', 'C', false),
            ],
            submissions: [
              { selectedOptionRefs: ['a', 'b'], textAnswer: null }, // correct (exact set)
              { selectedOptionRefs: ['a'], textAnswer: null }, // incorrect (partial)
              { selectedOptionRefs: ['a', 'b', 'c'], textAnswer: null }, // incorrect (superset)
            ],
            revealCorrectness: true,
          }),
        ),
      );
      expect(result.correctCount).toBe(1);
      expect(result.incorrectCount).toBe(2);
      expect(result.correctnessRate).toBeCloseTo(1 / 3);
    });

    it('hides isCorrect when revealCorrectness is false', () => {
      const result = asQuiz(
        aggregateResults(
          baseInput({
            snapshotType: 'quiz',
            options: [OPT('a', 'a', 'A', true), OPT('b', 'b', 'B', false)],
            submissions: [{ selectedOptionRefs: ['a'], textAnswer: null }],
            revealCorrectness: false,
          }),
        ),
      );
      expect(result.options[0].isCorrect).toBeUndefined();
      expect(result.options[1].isCorrect).toBeUndefined();
    });

    it('correctnessRate is 0 when no responses', () => {
      const result = asQuiz(
        aggregateResults(
          baseInput({
            snapshotType: 'quiz',
            options: [OPT('a', 'a', 'A', true)],
            submissions: [],
            revealCorrectness: true,
          }),
        ),
      );
      expect(result.correctCount).toBe(0);
      expect(result.incorrectCount).toBe(0);
      expect(result.correctnessRate).toBe(0);
      expect(result.totalResponses).toBe(0);
    });
  });

  describe('open_text', () => {
    it('returns anonymized text list, filtering null textAnswer', () => {
      const result = asOpenText(
        aggregateResults(
          baseInput({
            snapshotType: 'open_text',
            status: 'open',
            options: [],
            submissions: [
              { selectedOptionRefs: null, textAnswer: 'first' },
              { selectedOptionRefs: null, textAnswer: null },
              { selectedOptionRefs: null, textAnswer: 'third' },
            ],
          }),
        ),
      );
      expect(result).toEqual({
        snapshotType: 'open_text',
        status: 'open',
        responses: [{ text: 'first' }, { text: 'third' }],
        totalResponses: 3,
      });
    });

    it('empty submissions -> empty responses', () => {
      const result = asOpenText(
        aggregateResults(
          baseInput({
            snapshotType: 'open_text',
            options: [],
            submissions: [],
          }),
        ),
      );
      expect(result.responses).toEqual([]);
      expect(result.totalResponses).toBe(0);
    });
  });

  describe('defensive', () => {
    it('ignores unknown option UUIDs in selectedOptionRefs', () => {
      const result = asPoll(
        aggregateResults(
          baseInput({
            snapshotType: 'poll',
            selectionMode: 'single',
            options: [OPT('a', 'a', 'A')],
            submissions: [
              { selectedOptionRefs: ['a'], textAnswer: null },
              { selectedOptionRefs: ['unknown'], textAnswer: null },
            ],
          }),
        ),
      );
      expect(result.options[0].count).toBe(1);
      expect(result.totalResponses).toBe(2);
    });

    it('treats null selectedOptionRefs as no selection', () => {
      const result = asPoll(
        aggregateResults(
          baseInput({
            snapshotType: 'poll',
            selectionMode: 'single',
            options: [OPT('a', 'a', 'A')],
            submissions: [{ selectedOptionRefs: null, textAnswer: null }],
          }),
        ),
      );
      expect(result.options[0].count).toBe(0);
      expect(result.totalResponses).toBe(1);
    });

    it('throws on unsupported snapshotType', () => {
      expect(() =>
        aggregateResults(baseInput({ snapshotType: 'unknown_type' })),
      ).toThrow(/Unsupported snapshotType/);
    });
  });
});
