import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ApiResponse } from '../http-client';
import type { OperationMetrics } from '../metrics';

export interface SubmissionBurstParticipant {
  index: number;
  participantToken: string;
  answered: boolean;
  answerOptionId?: string;
}

export interface SubmissionBurstFailure {
  client: string;
  participantIndex: number;
  requestId: string;
  httpStatus: number;
  errorCode: string | null;
  elapsedMs: number;
}

export interface SubmissionBurstWindow {
  startedAtMs: number;
  completedAtMs: number;
  submitWindowMs: number;
  attemptedSubmissionCount: number;
  successfulSubmissionCount: number;
  failedSubmissionCount: number;
  http500Count: number;
  failureEvidence: SubmissionBurstFailure[];
  gateThresholdMs: number;
  gate: 'PASS' | 'FAIL';
}

export interface SubmissionBurstResult {
  answerByIndex: Map<number, string>;
  submitRecords: Map<
    number,
    {
      requestId: string;
      requestStartMs: number;
      responseEndMs: number;
      submissionId?: string;
    }
  >;
  submitWindow: SubmissionBurstWindow;
}

export interface SubmissionBurstInput {
  participants: SubmissionBurstParticipant[];
  optionIds: string[];
  runId: string;
  liveSessionId: string;
  sessionQuestionId: string;
  operation: OperationMetrics;
  gateThresholdMs: number;
  toRelativeMs: (monotonicMs: number) => number;
  submitRaw: (
    operation: OperationMetrics,
    liveSessionId: string,
    sessionQuestionId: string,
    participantToken: string,
    answer: Record<string, unknown>,
    idempotencyKey: string,
    requestId?: string,
  ) => Promise<ApiResponse<{ id: string; participantId: string }>>;
  createIdempotencyKey?: () => string;
  now?: () => number;
}

export async function executeSubmissionBurst(
  input: SubmissionBurstInput,
): Promise<SubmissionBurstResult> {
  const now = input.now ?? performance.now.bind(performance);
  const createIdempotencyKey = input.createIdempotencyKey ?? randomUUID;
  const answeredParticipants = input.participants.filter(
    (participant) => participant.answered,
  );
  const answerByIndex = new Map<number, string>();
  const submitRecords: SubmissionBurstResult['submitRecords'] = new Map();
  const failures: SubmissionBurstFailure[] = [];
  let successfulSubmissionCount = 0;
  const startedAtMs = input.toRelativeMs(now());

  await Promise.all(
    answeredParticipants.map(async (participant) => {
      const optionId =
        input.optionIds[participant.index % input.optionIds.length] ?? '';
      participant.answerOptionId = optionId;
      answerByIndex.set(participant.index, optionId);
      const requestId = `w3-${input.runId}-${participant.index}`;
      const requestStart = now();
      const result = await input.submitRaw(
        input.operation,
        input.liveSessionId,
        input.sessionQuestionId,
        participant.participantToken,
        { selectedOptionRefs: [optionId] },
        createIdempotencyKey(),
        requestId,
      );
      const responseEnd = now();
      submitRecords.set(participant.index, {
        requestId,
        requestStartMs: input.toRelativeMs(requestStart),
        responseEndMs: input.toRelativeMs(responseEnd),
        submissionId: result.data?.id,
      });
      if (result.status < 200 || result.status >= 300 || !result.data?.id) {
        failures.push({
          client: `p${participant.index}`,
          participantIndex: participant.index,
          requestId,
          httpStatus: result.status,
          errorCode: result.errorCode ?? null,
          elapsedMs: result.elapsedMs ?? responseEnd - requestStart,
        });
      } else {
        successfulSubmissionCount += 1;
      }
    }),
  );

  const completedAtMs = input.toRelativeMs(now());
  const submitWindowMs = completedAtMs - startedAtMs;
  return {
    answerByIndex,
    submitRecords,
    submitWindow: {
      startedAtMs,
      completedAtMs,
      submitWindowMs,
      attemptedSubmissionCount: answeredParticipants.length,
      successfulSubmissionCount,
      failedSubmissionCount: failures.length,
      http500Count: failures.filter((failure) => failure.httpStatus === 500)
        .length,
      failureEvidence: failures,
      gateThresholdMs: input.gateThresholdMs,
      gate: submitWindowMs <= input.gateThresholdMs ? 'PASS' : 'FAIL',
    },
  };
}
