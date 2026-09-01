import { normalizeQuestion, validateQuestion } from './question-contract';
import { QuestionValidationError } from '../../../common/errors';

describe('question-contract (multi-type validation)', () => {
  describe('poll single', () => {
    it('normalizes a valid poll single-choice question', () => {
      const result = normalizeQuestion({
        type: 'poll',
        prompt: '哪一個？',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
      expect(result.type).toBe('poll');
      expect(result.selectionMode).toBe('single');
      expect(result.options).toHaveLength(2);
      expect(result.correctOptionRefs).toEqual([]);
    });

    it('rejects correctOptionRefs on poll', () => {
      const issues = validateQuestion({
        type: 'poll',
        prompt: 'p',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
        correctOptionRefs: ['a'],
      });
      expect(issues.some((i) => i.code === 'FIELD_FORBIDDEN')).toBe(true);
    });
  });

  describe('poll multiple', () => {
    it('normalizes a valid poll multiple-choice question', () => {
      const result = normalizeQuestion({
        type: 'poll',
        prompt: '複選',
        selectionMode: 'multiple',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
      expect(result.selectionMode).toBe('multiple');
      expect(result.correctOptionRefs).toEqual([]);
    });

    it('rejects poll without selectionMode', () => {
      const issues = validateQuestion({
        type: 'poll',
        prompt: 'p',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
      expect(issues.some((i) => i.code === 'FIELD_REQUIRED')).toBe(true);
    });
  });

  describe('open_text', () => {
    it('normalizes a valid open_text question', () => {
      const result = normalizeQuestion({
        type: 'open_text',
        prompt: '請申論',
      });
      expect(result.type).toBe('open_text');
      expect(result.selectionMode).toBeNull();
      expect(result.options).toEqual([]);
      expect(result.correctOptionRefs).toEqual([]);
    });

    it('rejects options/selectionMode/correctOptionRefs on open_text', () => {
      const issues = validateQuestion({
        type: 'open_text',
        prompt: 'p',
        options: [{ optionRef: 'a', text: 'A' }],
        selectionMode: 'single',
        correctOptionRefs: ['a'],
      });
      expect(issues.some((i) => i.code === 'FIELD_FORBIDDEN')).toBe(true);
    });
  });

  describe('quiz', () => {
    it('normalizes a valid single-answer quiz', () => {
      const result = normalizeQuestion({
        type: 'quiz',
        prompt: '何者正確？',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
        correctOptionRefs: ['a'],
      });
      expect(result.type).toBe('quiz');
      expect(result.selectionMode).toBeNull();
      expect(result.correctOptionRefs).toEqual(['a']);
    });

    it('normalizes a valid multi-answer quiz', () => {
      const result = normalizeQuestion({
        type: 'quiz',
        prompt: '哪些正確？',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
          { optionRef: 'c', text: 'C' },
        ],
        correctOptionRefs: ['a', 'c'],
      });
      expect(result.correctOptionRefs).toEqual(['a', 'c']);
    });

    it('rejects quiz without correctOptionRefs', () => {
      const issues = validateQuestion({
        type: 'quiz',
        prompt: 'p',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
      expect(
        issues.some(
          (i) =>
            i.code === 'FIELD_REQUIRED' || i.code === 'CORRECT_OPTION_INVALID',
        ),
      ).toBe(true);
    });

    it('rejects quiz correctOptionRefs referencing a nonexistent option', () => {
      const issues = validateQuestion({
        type: 'quiz',
        prompt: 'p',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
        correctOptionRefs: ['zzz'],
      });
      expect(issues.some((i) => i.code === 'CORRECT_OPTION_INVALID')).toBe(
        true,
      );
    });

    it('does not echo caller-controlled type or correct reference values', () => {
      const secretType = 'secret-question-type';
      const secretRef = 'secret-correct-ref';
      const selectionIssues = validateQuestion({
        type: 'open_text',
        prompt: 'p',
        selectionMode: secretType,
      });
      const referenceIssues = validateQuestion({
        type: 'quiz',
        prompt: 'p',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
        correctOptionRefs: [secretRef],
      });

      expect(
        JSON.stringify([...selectionIssues, ...referenceIssues]),
      ).not.toContain(secretType);
      expect(JSON.stringify(referenceIssues)).not.toContain(secretRef);
    });

    it('rejects quiz with selectionMode set', () => {
      const issues = validateQuestion({
        type: 'quiz',
        prompt: 'p',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
        correctOptionRefs: ['a'],
      });
      expect(issues.some((i) => i.code === 'FIELD_FORBIDDEN')).toBe(true);
    });

    it('rejects duplicate correctOptionRefs', () => {
      const issues = validateQuestion({
        type: 'quiz',
        prompt: 'p',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
        correctOptionRefs: ['a', 'a'],
      });
      expect(issues.some((i) => i.code === 'CORRECT_OPTION_INVALID')).toBe(
        true,
      );
    });
  });

  describe('shared', () => {
    it('rejects an unknown question type', () => {
      const issues = validateQuestion({
        type: 'ranking',
        prompt: 'p',
      });
      expect(issues.some((i) => i.code === 'QUESTION_TYPE_INVALID')).toBe(true);
    });

    it('throws the first issue from normalizeQuestion', () => {
      expect(() => normalizeQuestion({ type: 'open_text' })).toThrow(
        QuestionValidationError,
      );
    });

    it('rejects duplicate option text after normalization', () => {
      const issues = validateQuestion({
        type: 'poll',
        prompt: 'p',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'a ' },
        ],
      });
      expect(issues.some((i) => i.code === 'OPTION_DUPLICATE')).toBe(true);
    });

    it('rejects fewer than 2 options for poll', () => {
      const issues = validateQuestion({
        type: 'poll',
        prompt: 'p',
        selectionMode: 'single',
        options: [{ optionRef: 'a', text: 'A' }],
      });
      expect(issues.some((i) => i.code === 'OPTION_COUNT_INVALID')).toBe(true);
    });
  });
});
