import { hashToken } from '../../../common/crypto';
import {
  normalizePollSingleChoice,
  type NormalizedPollSingleChoice,
  type PollSingleChoiceInput,
} from './poll-single-choice';

export const POLL_SINGLE_CHOICE_QUESTION_INPUT: PollSingleChoiceInput = {
  type: 'poll',
  prompt: '目前你最想釐清哪一個概念？',
  selectionMode: 'single',
  options: [
    { optionRef: 'source', text: '資料來源' },
    { optionRef: 'bias', text: '樣本偏差' },
    { optionRef: 'causality', text: '因果關係' },
  ],
};

export const POLL_SINGLE_CHOICE_IDS = {
  courseId: '0190c6b8-0000-7000-8000-000000000001',
  questionId: '0190c6b8-0000-7000-8000-000000000002',
  optionIds: [
    '0190c6b8-0000-7000-8000-000000000003',
    '0190c6b8-0000-7000-8000-000000000004',
    '0190c6b8-0000-7000-8000-000000000005',
  ],
  liveSessionId: '0190c6b8-0000-7000-8000-000000000006',
  sessionQuestionId: '0190c6b8-0000-7000-8000-000000000007',
  participantId: '0190c6b8-0000-7000-8000-000000000008',
  submissionId: '0190c6b8-0000-7000-8000-000000000009',
} as const;

export interface PollSingleChoiceMockContract {
  question: NormalizedPollSingleChoice;
  liveSession: {
    id: string;
    courseId: string;
    status: 'active';
  };
  sessionQuestion: {
    id: string;
    liveSessionId: string;
    status: 'open';
    snapshot: NormalizedPollSingleChoice;
  };
  participant: {
    id: string;
    liveSessionId: string;
    displayName: string;
    tokenHash: string;
  };
  submission: {
    id: string;
    liveSessionId: string;
    sessionQuestionId: string;
    participantId: string;
    idempotencyKey: string;
    selectedOptionRefs: [string];
  };
}

/**
 * Build the canonical mock state without persisting raw participant tokens.
 * The caller supplies the token only so tests can assert the hash boundary.
 */
export function buildPollSingleChoiceMockContract(
  rawParticipantToken: string,
  idempotencyKey = '0190c6b8-0000-7000-8000-000000000010',
): PollSingleChoiceMockContract {
  const question = normalizePollSingleChoice(POLL_SINGLE_CHOICE_QUESTION_INPUT);
  const snapshot = structuredClone(question);
  const selectedOptionRefs: [string] = [POLL_SINGLE_CHOICE_IDS.optionIds[0]];

  return {
    question,
    liveSession: {
      id: POLL_SINGLE_CHOICE_IDS.liveSessionId,
      courseId: POLL_SINGLE_CHOICE_IDS.courseId,
      status: 'active',
    },
    sessionQuestion: {
      id: POLL_SINGLE_CHOICE_IDS.sessionQuestionId,
      liveSessionId: POLL_SINGLE_CHOICE_IDS.liveSessionId,
      status: 'open',
      snapshot,
    },
    participant: {
      id: POLL_SINGLE_CHOICE_IDS.participantId,
      liveSessionId: POLL_SINGLE_CHOICE_IDS.liveSessionId,
      displayName: '小明',
      tokenHash: hashToken(rawParticipantToken),
    },
    submission: {
      id: POLL_SINGLE_CHOICE_IDS.submissionId,
      liveSessionId: POLL_SINGLE_CHOICE_IDS.liveSessionId,
      sessionQuestionId: POLL_SINGLE_CHOICE_IDS.sessionQuestionId,
      participantId: POLL_SINGLE_CHOICE_IDS.participantId,
      idempotencyKey,
      selectedOptionRefs,
    },
  };
}
