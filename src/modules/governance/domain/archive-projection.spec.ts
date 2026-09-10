import { parseArchivedResult, projectArchive } from './archive-projection';

describe('archive projection', () => {
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

  it('deeply reconstructs persisted results through the public allowlist', () => {
    const input = {
      schemaVersion: 1,
      accountId: 'root-secret',
      questions: [
        {
          id: 'open',
          position: 3,
          prompt: 'Explain',
          participantId: 'question-secret',
          result: {
            snapshotType: 'open_text',
            status: 'closed',
            responses: [
              {
                text: 'answer',
                displayName: 'Learner',
                submittedAt: 'secret',
              },
            ],
            totalResponses: 1,
            options: [{ participantId: 'wrong-variant' }],
          },
        },
        {
          id: 'quiz',
          position: 2,
          prompt: 'Quiz',
          sessionCode: 'question-secret',
          result: {
            snapshotType: 'quiz',
            status: 'closed',
            options: [
              {
                optionId: 'qo',
                optionRef: null,
                text: 'A',
                count: 1,
                isCorrect: true,
                accountId: 'option-secret',
              },
            ],
            totalResponses: 1,
            correctCount: 1,
            incorrectCount: 0,
            correctnessRate: 1,
            selectionMode: 'single',
          },
        },
        {
          id: 'poll',
          position: 1,
          prompt: 'Poll',
          result: {
            snapshotType: 'poll',
            selectionMode: 'multiple',
            status: 'closed',
            options: [
              {
                optionId: 'po',
                optionRef: 'a',
                text: 'A',
                count: 1,
                isCorrect: true,
                participantId: 'option-secret',
              },
            ],
            totalResponses: 1,
            correctCount: 1,
            displayName: 'result-secret',
          },
        },
      ],
    };

    const result = parseArchivedResult(input);

    expect(result).toEqual({
      schemaVersion: 1,
      questions: [
        {
          id: 'poll',
          position: 1,
          prompt: 'Poll',
          result: {
            snapshotType: 'poll',
            selectionMode: 'multiple',
            status: 'closed',
            options: [{ optionId: 'po', optionRef: 'a', text: 'A', count: 1 }],
            totalResponses: 1,
          },
        },
        {
          id: 'quiz',
          position: 2,
          prompt: 'Quiz',
          result: {
            snapshotType: 'quiz',
            status: 'closed',
            options: [
              {
                optionId: 'qo',
                optionRef: null,
                text: 'A',
                count: 1,
                isCorrect: true,
              },
            ],
            totalResponses: 1,
            correctCount: 1,
            incorrectCount: 0,
            correctnessRate: 1,
          },
        },
        {
          id: 'open',
          position: 3,
          prompt: 'Explain',
          result: {
            snapshotType: 'open_text',
            status: 'closed',
            responses: [{ text: 'answer' }],
            totalResponses: 1,
          },
        },
      ],
    });
    expect(result).not.toBe(input);
    expect(result.questions[0]).not.toBe(input.questions[2]);
    expect(input.questions[0].participantId).toBe('question-secret');
    expect(JSON.stringify(result)).not.toMatch(
      /participant|account|displayName|token|sessionCode|submittedAt|selectedOptionRefs|isCorrect.*poll/,
    );
  });

  it.each([
    [{ schemaVersion: 2, questions: [] }],
    [{ schemaVersion: 1, questions: [null] }],
    [
      {
        schemaVersion: 1,
        questions: [
          {
            id: 'q',
            position: 0,
            prompt: 'Prompt',
            result: { snapshotType: 'open_text', status: 'closed' },
          },
        ],
      },
    ],
    [
      {
        schemaVersion: 1,
        questions: [
          {
            id: 'q',
            position: 1,
            prompt: 'Prompt',
            result: {
              snapshotType: 'poll',
              selectionMode: 'invalid',
              status: 'closed',
              options: [],
              totalResponses: 0,
            },
          },
        ],
      },
    ],
    [
      {
        schemaVersion: 1,
        questions: [
          {
            id: 'q',
            position: 1,
            prompt: 'Prompt',
            result: {
              snapshotType: 'quiz',
              status: 'open',
              options: [],
              totalResponses: 0,
              correctCount: 0,
              incorrectCount: 0,
              correctnessRate: 0,
            },
          },
        ],
      },
    ],
    [
      {
        schemaVersion: 1,
        questions: [
          {
            id: 'q',
            position: 1,
            prompt: 'Prompt',
            result: {
              snapshotType: 'quiz',
              status: 'closed',
              options: [],
              totalResponses: 0,
              correctCount: 0,
              incorrectCount: 0,
              correctnessRate: Number.NaN,
            },
          },
        ],
      },
    ],
    [
      {
        schemaVersion: 1,
        questions: [
          {
            id: 'q',
            position: 1,
            prompt: 'Prompt',
            result: {
              snapshotType: 'open_text',
              status: 'closed',
              responses: [{ text: 1 }],
              totalResponses: 1,
            },
          },
        ],
      },
    ],
  ])('rejects malformed persisted archive payloads', (input) => {
    expect(() => parseArchivedResult(input)).toThrow();
  });
});
