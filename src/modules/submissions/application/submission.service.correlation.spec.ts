import { SubmissionService } from './submission.service';

const liveSessionId = '01999999-9999-7999-8999-999999999991';
const sessionQuestionId = '01999999-9999-7999-8999-999999999992';
const participantId = '01999999-9999-7999-8999-999999999993';
const idempotencyKey = '01999999-9999-7999-8999-999999999994';
const correlationId = 'w3-correlation-test-1';
const submission = {
  id: '01999999-9999-7999-8999-999999999995',
  liveSessionId,
  sessionQuestionId,
  participantId,
  selectedOptionRefs: ['01999999-9999-7999-8999-999999999996'],
  textAnswer: null,
  submittedAt: new Date('2026-10-07T00:00:00.000Z'),
};

function createHarness(traceEnabled: boolean) {
  const transactions = {
    run: jest.fn().mockResolvedValue({ submission, fresh: false }),
  };
  const eventBus = { publish: jest.fn() };
  const outbox = { append: jest.fn() };
  const trace = {
    enabled: traceEnabled,
    runId: 'w3-correlation-test',
    recordTiming: jest.fn(),
    recordTransactionDiagnostic: jest.fn(),
  };
  const service = new SubmissionService(
    transactions as never,
    eventBus as never,
    outbox as never,
    trace as never,
  );
  const submit = (traceContext?: { correlationId?: string }) =>
    service.submit(
      liveSessionId,
      { liveSessionId, participantId },
      idempotencyKey,
      {
        sessionQuestionId,
        selectedOptionRefs: ['alpha'],
      },
      traceContext,
    );

  return { transactions, eventBus, outbox, trace, submit };
}

describe('SubmissionService transaction timing correlation', () => {
  it('uses the HTTP-derived correlation ID for transaction timing', async () => {
    const harness = createHarness(true);

    await expect(harness.submit({ correlationId })).resolves.toEqual(
      submission,
    );

    expect(harness.trace.recordTiming).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId }),
    );
    const options = harness.transactions.run.mock.calls[0]?.[1];
    options?.diagnostics?.startedAt?.();
    expect(harness.trace.recordTiming).toHaveBeenLastCalledWith(
      expect.objectContaining({
        correlationId,
        transactionStartedAt: expect.any(String),
      }),
    );
    expect(harness.outbox.append).not.toHaveBeenCalled();
    expect(harness.eventBus.publish).not.toHaveBeenCalled();
  });

  it('preserves a generated fallback for callers without trace context', async () => {
    const harness = createHarness(true);

    await expect(harness.submit()).resolves.toEqual(submission);

    expect(harness.trace.recordTiming).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: expect.any(String),
      }),
    );
    const recordedCorrelationId = harness.trace.recordTiming.mock.calls[0]?.[0]
      ?.correlationId as string;
    expect(recordedCorrelationId).not.toBe(correlationId);
    expect(recordedCorrelationId).not.toHaveLength(0);
  });

  it('does not emit diagnostics or alter submission behavior when trace is disabled', async () => {
    const harness = createHarness(false);

    await expect(harness.submit({ correlationId })).resolves.toEqual(
      submission,
    );

    expect(harness.transactions.run).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
    );
    expect(harness.trace.recordTiming).not.toHaveBeenCalled();
    expect(harness.trace.recordTransactionDiagnostic).not.toHaveBeenCalled();
    expect(harness.outbox.append).not.toHaveBeenCalled();
    expect(harness.eventBus.publish).not.toHaveBeenCalled();
  });
});
