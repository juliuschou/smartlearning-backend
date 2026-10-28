export type W3DriverMode = 'full' | 'submit-only';

export function parseW3DriverMode(argv: readonly string[]): W3DriverMode {
  if (argv.length === 0) return 'full';
  if (argv.length === 1 && argv[0] === '--submit-only') return 'submit-only';
  throw new Error(
    'Unsupported W3 arguments; use no arguments for full mode or exactly --submit-only.',
  );
}

export interface W3DriverPhases<
  TPrepared,
  TSubmission,
  TFullResult,
  TSubmitOnlyResult,
> {
  prepare: () => Promise<TPrepared>;
  submit: (prepared: TPrepared) => Promise<TSubmission>;
  runFull: (
    prepared: TPrepared,
    submission: TSubmission,
  ) => Promise<TFullResult>;
  finalizeSubmitOnly: (
    prepared: TPrepared,
    submission: TSubmission,
  ) => Promise<TSubmitOnlyResult>;
}

export interface SubmitOnlyTimingRecord {
  correlationId: string;
  transactionDiagnostic?: {
    acquireStartedAt?: string;
    bodyStartedAt?: string;
    bodyCompletedAt?: string;
    succeeded?: boolean;
    error?: {
      errorType: string;
      databaseCode?: string;
    };
  };
}

export interface SubmitOnlyTransactionEvidence {
  requestId: string;
  status: 'OBSERVED' | 'INCOMPLETE' | 'NOT_OBSERVED';
  acquisitionMs?: number;
  callbackMs?: number;
  succeeded?: boolean;
  errorType?: string;
  databaseCode?: string;
}

export type SubmitOnlyTimingCorrelationStatus =
  | 'HEALTHY'
  | 'CORRELATION_ID_MISMATCH'
  | 'NO_TIMINGS_OBSERVED'
  | 'PARTIAL_MATCH';

export interface SubmitOnlyTimingCorrelationSummary {
  expectedTimingIdCount: number;
  observedTimingIdCount: number;
  matchedTimingIdCount: number;
  notObservedTimingCount: number;
  status: SubmitOnlyTimingCorrelationStatus;
}

export function summarizeSubmitOnlyTimingCorrelation(
  requestIds: readonly string[],
  timings: readonly SubmitOnlyTimingRecord[],
): SubmitOnlyTimingCorrelationSummary {
  const expectedIds = new Set(requestIds);
  const observedIds = new Set(
    timings
      .map((timing) => timing.correlationId)
      .filter((correlationId) => correlationId.length > 0),
  );
  let matchedTimingIdCount = 0;
  for (const requestId of expectedIds) {
    if (observedIds.has(requestId)) matchedTimingIdCount += 1;
  }
  const expectedTimingIdCount = expectedIds.size;
  const observedTimingIdCount = observedIds.size;
  const notObservedTimingCount = expectedTimingIdCount - matchedTimingIdCount;
  const status: SubmitOnlyTimingCorrelationStatus =
    observedTimingIdCount === 0
      ? 'NO_TIMINGS_OBSERVED'
      : matchedTimingIdCount === 0
        ? 'CORRELATION_ID_MISMATCH'
        : matchedTimingIdCount === expectedTimingIdCount
          ? 'HEALTHY'
          : 'PARTIAL_MATCH';

  return {
    expectedTimingIdCount,
    observedTimingIdCount,
    matchedTimingIdCount,
    notObservedTimingCount,
    status,
  };
}

export function projectSubmitOnlyTransactionEvidence(
  requestIds: readonly string[],
  timings: readonly SubmitOnlyTimingRecord[],
): SubmitOnlyTransactionEvidence[] {
  const byCorrelationId = new Map(
    timings.map((timing) => [timing.correlationId, timing]),
  );
  return requestIds.map((requestId) => {
    const diagnostic = byCorrelationId.get(requestId)?.transactionDiagnostic;
    if (!diagnostic) return { requestId, status: 'NOT_OBSERVED' };
    const acquisitionMs = durationMs(
      diagnostic.acquireStartedAt,
      diagnostic.bodyStartedAt,
    );
    const callbackMs = durationMs(
      diagnostic.bodyStartedAt,
      diagnostic.bodyCompletedAt,
    );
    const complete = acquisitionMs !== undefined && callbackMs !== undefined;
    return {
      requestId,
      status: complete ? 'OBSERVED' : 'INCOMPLETE',
      ...(acquisitionMs === undefined ? {} : { acquisitionMs }),
      ...(callbackMs === undefined ? {} : { callbackMs }),
      ...(diagnostic.succeeded === undefined
        ? {}
        : { succeeded: diagnostic.succeeded }),
      ...(diagnostic.error
        ? {
            errorType: diagnostic.error.errorType,
            ...(diagnostic.error.databaseCode
              ? { databaseCode: diagnostic.error.databaseCode }
              : {}),
          }
        : {}),
    };
  });
}

export function classifySubmitOnlyContention(input: {
  traceAvailable: boolean;
  transactionEvidence: readonly SubmitOnlyTransactionEvidence[];
  http500Count: number;
}): 'CONTENTION_OBSERVED' | 'NO_CONTENTION_OBSERVED' | 'INCONCLUSIVE' {
  if (
    !input.traceAvailable ||
    input.transactionEvidence.length === 0 ||
    input.transactionEvidence.some((evidence) => evidence.status !== 'OBSERVED')
  ) {
    return 'INCONCLUSIVE';
  }
  return input.http500Count > 0 ||
    input.transactionEvidence.some(
      (evidence) => evidence.succeeded === false || evidence.databaseCode,
    )
    ? 'CONTENTION_OBSERVED'
    : 'NO_CONTENTION_OBSERVED';
}

function durationMs(start: string | undefined, end: string | undefined) {
  if (!start || !end) return undefined;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

export async function runW3DriverPhases<
  TPrepared,
  TSubmission,
  TFullResult,
  TSubmitOnlyResult,
>(
  mode: W3DriverMode,
  phases: W3DriverPhases<
    TPrepared,
    TSubmission,
    TFullResult,
    TSubmitOnlyResult
  >,
): Promise<TFullResult | TSubmitOnlyResult> {
  const prepared = await phases.prepare();
  const submission = await phases.submit(prepared);
  return mode === 'submit-only'
    ? phases.finalizeSubmitOnly(prepared, submission)
    : phases.runFull(prepared, submission);
}
