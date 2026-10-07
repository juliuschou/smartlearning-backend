import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOperation } from '../metrics';
import {
  classifySubmitOnlyContention,
  parseW3DriverMode,
  projectSubmitOnlyTransactionEvidence,
  runW3DriverPhases,
  summarizeSubmitOnlyTimingCorrelation,
} from './driver-mode';
import { W3_ACCEPTANCE_PARTICIPANTS } from './run-contract';
import { executeSubmissionBurst } from './submission-burst';

async function main(): Promise<void> {
  assert.equal(parseW3DriverMode([]), 'full');
  assert.equal(parseW3DriverMode(['--submit-only']), 'submit-only');
  assert.throws(() => parseW3DriverMode(['--unknown']), /Unsupported/);
  assert.throws(
    () => parseW3DriverMode(['--submit-only', '--submit-only']),
    /Unsupported/,
  );
  assert.throws(() => parseW3DriverMode(['submit-only']), /Unsupported/);

  const submitOnlyCalls: string[] = [];
  const submitOnlyResult = await runW3DriverPhases('submit-only', {
    prepare: async () => {
      submitOnlyCalls.push('prepare');
      return 'prepared';
    },
    submit: async () => {
      submitOnlyCalls.push('submit');
      return 'submission';
    },
    runFull: async () => {
      throw new Error('full phases must not run in submit-only mode');
    },
    finalizeSubmitOnly: async () => {
      submitOnlyCalls.push('finalize-submit-only');
      return 'completed';
    },
  });
  assert.equal(submitOnlyResult, 'completed');
  assert.deepEqual(submitOnlyCalls, [
    'prepare',
    'submit',
    'finalize-submit-only',
  ]);

  const fullCalls: string[] = [];
  await runW3DriverPhases(parseW3DriverMode([]), {
    prepare: async () => {
      fullCalls.push('prepare');
      return undefined;
    },
    submit: async () => {
      fullCalls.push('submit');
      return undefined;
    },
    runFull: async () => {
      fullCalls.push('realtime-and-close');
      return undefined;
    },
    finalizeSubmitOnly: async () => {
      throw new Error('submit-only finalizer must not run in full mode');
    },
  });
  assert.deepEqual(fullCalls, ['prepare', 'submit', 'realtime-and-close']);

  const participants = Array.from(
    { length: W3_ACCEPTANCE_PARTICIPANTS },
    (_, index) => ({
      index,
      participantToken: `synthetic-token-${index}`,
      answered: true,
    }),
  );
  const pending: Array<() => void> = [];
  const calls: Array<{
    participantToken: string;
    optionId: string;
    requestId?: string;
  }> = [];
  let now = 1_000;
  const burstPromise = executeSubmissionBurst({
    participants,
    optionIds: ['option-a', 'option-b', 'option-c'],
    runId: 'w3-contention-unit',
    liveSessionId: 'live-session',
    sessionQuestionId: 'session-question',
    operation: createOperation('unit', 'http'),
    gateThresholdMs: 10_000,
    toRelativeMs: (value) => value - 1_000,
    now: () => now++,
    createIdempotencyKey: () => '00000000-0000-7000-8000-000000000001',
    submitRaw: async (
      _operation,
      _liveSessionId,
      _sessionQuestionId,
      participantToken,
      answer,
      _idempotencyKey,
      requestId,
    ) => {
      calls.push({
        participantToken,
        optionId: (answer.selectedOptionRefs as string[])[0] ?? '',
        requestId,
      });
      await new Promise<void>((resolve) => pending.push(resolve));
      const index = Number(requestId?.split('-').at(-1));
      return index === 17
        ? { status: 500, errorCode: 'INTERNAL_ERROR', elapsedMs: 2_083 }
        : {
            status: 201,
            data: { id: `submission-${index}`, participantId: `p-${index}` },
            elapsedMs: 5,
          };
    },
  });

  await Promise.resolve();
  assert.equal(
    calls.length,
    W3_ACCEPTANCE_PARTICIPANTS,
    'one Promise.all fan-out starts all 300 attempts before any resolves',
  );
  pending.forEach((resolve) => resolve());
  const burst = await burstPromise;
  assert.equal(burst.submitWindow.attemptedSubmissionCount, 300);
  assert.equal(burst.submitWindow.successfulSubmissionCount, 299);
  assert.equal(burst.submitWindow.failedSubmissionCount, 1);
  assert.equal(burst.submitWindow.http500Count, 1);
  assert.equal(
    burst.submitWindow.successfulSubmissionCount +
      burst.submitWindow.failedSubmissionCount,
    300,
  );
  assert.equal(calls[0]?.requestId, 'w3-w3-contention-unit-0');
  assert.equal(calls[299]?.requestId, 'w3-w3-contention-unit-299');
  assert.equal(calls[4]?.optionId, 'option-b');

  const requestIds = ['w3-run-0', 'w3-run-1'];
  const projected = projectSubmitOnlyTransactionEvidence(requestIds, [
    {
      correlationId: 'w3-run-0',
      transactionDiagnostic: {
        acquireStartedAt: '2026-10-06T00:00:00.000Z',
        bodyStartedAt: '2026-10-06T00:00:00.125Z',
        bodyCompletedAt: '2026-10-06T00:00:00.175Z',
        succeeded: false,
        error: {
          errorType: 'PrismaClientKnownRequestError',
          prismaCode: 'P2028',
          databaseCode: '55P03',
        },
      },
    },
  ]);
  assert.deepEqual(projected[0], {
    requestId: 'w3-run-0',
    status: 'OBSERVED',
    acquisitionMs: 125,
    callbackMs: 50,
    succeeded: false,
    errorType: 'PrismaClientKnownRequestError',
    prismaCode: 'P2028',
    databaseCode: '55P03',
  });
  assert.deepEqual(projected[1], {
    requestId: 'w3-run-1',
    status: 'NOT_OBSERVED',
  });
  assert.equal(
    classifySubmitOnlyContention({
      traceAvailable: true,
      transactionEvidence: projected,
      http500Count: 1,
    }),
    'INCONCLUSIVE',
    'one missing transaction record prevents a PASS-like conclusion',
  );
  assert.equal(
    classifySubmitOnlyContention({
      traceAvailable: false,
      transactionEvidence: [],
      http500Count: 0,
    }),
    'INCONCLUSIVE',
  );
  assert.equal(
    classifySubmitOnlyContention({
      traceAvailable: true,
      transactionEvidence: [projected[0]!],
      http500Count: 1,
    }),
    'CONTENTION_OBSERVED',
  );
  assert.equal(JSON.stringify(projected).includes('raw message'), false);
  assert.equal(JSON.stringify(projected).includes('meta'), false);

  const expectedTimingIds = Array.from(
    { length: W3_ACCEPTANCE_PARTICIPANTS },
    (_, index) => `w3-timing-${index}`,
  );
  const matchedTimings = expectedTimingIds.map((correlationId) => ({
    correlationId,
    transactionDiagnostic: {
      acquireStartedAt: '2026-10-06T00:00:00.000Z',
      bodyStartedAt: '2026-10-06T00:00:00.010Z',
      bodyCompletedAt: '2026-10-06T00:00:00.020Z',
      succeeded: true,
    },
  }));
  const matchedEvidence = projectSubmitOnlyTransactionEvidence(
    expectedTimingIds,
    matchedTimings,
  );
  assert.equal(
    matchedEvidence.filter((evidence) => evidence.status === 'OBSERVED').length,
    W3_ACCEPTANCE_PARTICIPANTS,
  );
  assert.deepEqual(
    summarizeSubmitOnlyTimingCorrelation(expectedTimingIds, matchedTimings),
    {
      expectedTimingIdCount: 300,
      observedTimingIdCount: 300,
      matchedTimingIdCount: 300,
      notObservedTimingCount: 0,
      status: 'HEALTHY',
    },
  );

  const disjointTimings = expectedTimingIds.map((_, index) => ({
    correlationId: `server-random-${index}`,
  }));
  assert.deepEqual(
    summarizeSubmitOnlyTimingCorrelation(expectedTimingIds, disjointTimings),
    {
      expectedTimingIdCount: 300,
      observedTimingIdCount: 300,
      matchedTimingIdCount: 0,
      notObservedTimingCount: 300,
      status: 'CORRELATION_ID_MISMATCH',
    },
  );
  assert.equal(
    summarizeSubmitOnlyTimingCorrelation(expectedTimingIds, []).status,
    'NO_TIMINGS_OBSERVED',
  );
  assert.deepEqual(
    summarizeSubmitOnlyTimingCorrelation(
      expectedTimingIds,
      matchedTimings.slice(0, 299),
    ),
    {
      expectedTimingIdCount: 300,
      observedTimingIdCount: 299,
      matchedTimingIdCount: 299,
      notObservedTimingCount: 1,
      status: 'PARTIAL_MATCH',
    },
  );

  await assert.rejects(
    runW3DriverPhases('submit-only', {
      prepare: async () => {
        throw new Error('fixture invalid');
      },
      submit: async () => undefined,
      runFull: async () => undefined,
      finalizeSubmitOnly: async () => undefined,
    }),
    /fixture invalid/,
  );
  await assert.rejects(
    runW3DriverPhases('submit-only', {
      prepare: async () => undefined,
      submit: async () => undefined,
      runFull: async () => undefined,
      finalizeSubmitOnly: async () => {
        throw new Error('artifact write failed');
      },
    }),
    /artifact write failed/,
  );

  const driverSource = await readFile(
    `${process.cwd()}/scripts/load-harness/w3/run-w3.ts`,
    'utf8',
  );
  const fullPg = driverSource.indexOf("if (mode === 'full')");
  const participantJoin = driverSource.indexOf('// ---- P1 join + connect');
  const submitOnlyBranch = driverSource.indexOf("if (mode === 'submit-only')");
  const participantSockets = driverSource.indexOf(
    'const clients: ParticipantClient[]',
  );
  const phaseA = driverSource.indexOf('// ---- P3 Phase A');
  const phaseB = driverSource.indexOf('// ---- P4 Phase B');
  const publisherDrain = driverSource.indexOf('// Bounded drain:');
  const questionClose = driverSource.indexOf('// ---- P5/P6 Phase C');
  const broadVerdict = driverSource.indexOf('// ---- P8 verdicts');
  assert.ok(
    fullPg < participantJoin &&
      participantJoin < submitOnlyBranch &&
      submitOnlyBranch < participantSockets &&
      participantSockets < phaseA &&
      phaseA < phaseB &&
      phaseB < publisherDrain &&
      publisherDrain < questionClose &&
      questionClose < broadVerdict,
    'no-argument full W3 keeps the established phase ordering',
  );

  process.stdout.write('run-w3 submit-only specs: all assertions passed\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
