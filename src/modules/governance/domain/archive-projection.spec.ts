import { projectArchive } from './archive-projection';

describe('projectArchive', () => {
  it('preserves ordering and emits anonymous aggregates', () => {
    const result = projectArchive([
      {
        id: 'q-2',
        position: 2,
        snapshotType: 'open_text',
        snapshotPrompt: 'Explain',
        snapshotSelectionMode: null,
        options: [],
        submissions: [{ selectedOptionRefs: null, textAnswer: 'hello' }],
      },
      {
        id: 'q-1',
        position: 1,
        snapshotType: 'poll',
        snapshotPrompt: 'Pick',
        snapshotSelectionMode: 'single',
        options: [
          {
            id: 'o-2',
            optionRef: 'b',
            text: 'B',
            isCorrect: false,
            position: 2,
          },
          {
            id: 'o-1',
            optionRef: 'a',
            text: 'A',
            isCorrect: false,
            position: 1,
          },
        ],
        submissions: [{ selectedOptionRefs: ['o-1'], textAnswer: null }],
      },
    ]);

    expect(result.schemaVersion).toBe(1);
    expect(result.questions.map((q) => q.id)).toEqual(['q-1', 'q-2']);
    expect(result.questions[0].result).toMatchObject({
      snapshotType: 'poll',
      totalResponses: 1,
      options: [
        { optionId: 'o-1', count: 1 },
        { optionId: 'o-2', count: 0 },
      ],
    });
    expect(result.questions[1].result).toEqual({
      snapshotType: 'open_text',
      status: 'closed',
      responses: [{ text: 'hello' }],
      totalResponses: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /participant|account|displayName|token|sessionCode|submittedAt|selectedOptionRefs/,
    );
  });

  it('reveals quiz correctness only as aggregate fields', () => {
    const result = projectArchive([
      {
        id: 'q',
        position: 1,
        snapshotType: 'quiz',
        snapshotPrompt: 'Quiz',
        snapshotSelectionMode: null,
        options: [
          {
            id: 'o-1',
            optionRef: 'a',
            text: 'A',
            isCorrect: true,
            position: 1,
          },
          {
            id: 'o-2',
            optionRef: 'b',
            text: 'B',
            isCorrect: false,
            position: 2,
          },
        ],
        submissions: [{ selectedOptionRefs: ['o-1'], textAnswer: null }],
      },
    ]);

    expect(result.questions[0].result).toMatchObject({
      correctCount: 1,
      incorrectCount: 0,
      correctnessRate: 1,
    });
  });
});
