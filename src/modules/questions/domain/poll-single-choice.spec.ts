import { hashToken } from '../../../common/crypto';
import {
  buildPollSingleChoiceMockContract,
  POLL_SINGLE_CHOICE_QUESTION_INPUT,
  POLL_SINGLE_CHOICE_IDS,
} from './poll-single-choice.contract';
import {
  normalizePollSingleChoice,
  validatePollSingleChoice,
  validateSingleChoiceAnswer,
} from './poll-single-choice';

describe('poll single-choice contract', () => {
  it('normalizes the canonical question and preserves ordered options', () => {
    const question = normalizePollSingleChoice({
      ...POLL_SINGLE_CHOICE_QUESTION_INPUT,
      prompt: `  ${POLL_SINGLE_CHOICE_QUESTION_INPUT.prompt}  `,
      options: POLL_SINGLE_CHOICE_QUESTION_INPUT.options.map((option) => ({
        ...option,
        text: ` ${option.text} `,
      })),
    });

    expect(question).toEqual({
      type: 'poll',
      prompt: '目前你最想釐清哪一個概念？',
      selectionMode: 'single',
      options: [
        { optionRef: 'source', text: '資料來源', position: 1 },
        { optionRef: 'bias', text: '樣本偏差', position: 2 },
        { optionRef: 'causality', text: '因果關係', position: 3 },
      ],
    });
  });

  it('rejects forbidden fields, invalid option count, and normalized duplicates', () => {
    const issues = validatePollSingleChoice({
      ...POLL_SINGLE_CHOICE_QUESTION_INPUT,
      correctOptionRefs: ['source'],
      options: [
        { optionRef: 'source', text: ' Data  ' },
        { optionRef: 'bias', text: 'data' },
      ],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FIELD_FORBIDDEN',
          field: 'correctOptionRefs',
        }),
        expect.objectContaining({
          code: 'OPTION_DUPLICATE',
          field: 'options[1].text',
        }),
      ]),
    );
    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OPTION_COUNT_INVALID' }),
      ]),
    );
  });

  it('rejects empty, overlong, and out-of-range options', () => {
    expect(
      validatePollSingleChoice({
        ...POLL_SINGLE_CHOICE_QUESTION_INPUT,
        prompt: ' ',
        options: [{ text: 'a' }],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'TEXT_EMPTY', field: 'prompt' }),
        expect.objectContaining({
          code: 'OPTION_COUNT_INVALID',
          field: 'options',
        }),
      ]),
    );

    expect(
      validatePollSingleChoice({
        ...POLL_SINGLE_CHOICE_QUESTION_INPUT,
        options: Array.from({ length: 11 }, (_, index) => ({
          text: `option-${index}`,
        })),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'OPTION_COUNT_INVALID',
          field: 'options',
        }),
      ]),
    );
  });

  it('rejects unsafe text and counts Unicode code points', () => {
    const validAstralPrompt = validatePollSingleChoice({
      ...POLL_SINGLE_CHOICE_QUESTION_INPUT,
      prompt: '😀'.repeat(1_000),
    });
    expect(validAstralPrompt).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'prompt', code: 'TEXT_TOO_LONG' }),
      ]),
    );

    const unsafe = validatePollSingleChoice({
      ...POLL_SINGLE_CHOICE_QUESTION_INPUT,
      prompt: 'safe' + '‮' + 'text',
      options: [
        { optionRef: 'source', text: 'Source data' },
        { optionRef: String.fromCharCode(0xd800), text: 'Sample bias' },
      ],
    });
    expect(unsafe).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'prompt', code: 'TEXT_UNSAFE' }),
        expect.objectContaining({
          field: 'options[1].optionRef',
          code: 'TEXT_UNSAFE',
        }),
      ]),
    );
  });

  it('models the immutable snapshot, token hash, and single-answer boundary', () => {
    const rawToken = 'fixture-participant-token';
    const contract = buildPollSingleChoiceMockContract(rawToken);
    contract.question.prompt = 'source changed after activation';

    expect(contract.sessionQuestion.snapshot.prompt).toBe(
      '目前你最想釐清哪一個概念？',
    );
    expect(contract.participant.tokenHash).toBe(hashToken(rawToken));
    expect(contract.participant.tokenHash).not.toBe(rawToken);
    expect(
      validateSingleChoiceAnswer(
        contract.submission.selectedOptionRefs,
        POLL_SINGLE_CHOICE_IDS.optionIds,
      ),
    ).toEqual([]);
    expect(
      validateSingleChoiceAnswer(
        [
          POLL_SINGLE_CHOICE_IDS.optionIds[0],
          POLL_SINGLE_CHOICE_IDS.optionIds[1],
        ],
        POLL_SINGLE_CHOICE_IDS.optionIds,
      ),
    ).toEqual([
      expect.objectContaining({
        code: 'OPTION_REF_INVALID',
        field: 'selectedOptionRefs',
      }),
    ]);
  });
});
