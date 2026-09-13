export interface TimingSummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function percentile(
  values: readonly number[],
  percentileValue: number,
): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

export function summarize(values: readonly number[]): TimingSummary {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : 0,
  };
}

export interface OperationMetrics {
  name: string;
  transport: 'http' | 'socket';
  timingsMs: number[];
  successCount: number;
  expectedErrorCount: number;
  unexpectedErrorCount: number;
  errors: Record<string, number>;
}

export function createOperation(
  name: string,
  transport: OperationMetrics['transport'],
): OperationMetrics {
  return {
    name,
    transport,
    timingsMs: [],
    successCount: 0,
    expectedErrorCount: 0,
    unexpectedErrorCount: 0,
    errors: {},
  };
}

export function recordError(
  operation: OperationMetrics,
  code: string,
  expected: boolean,
): void {
  operation.errors[code] = (operation.errors[code] ?? 0) + 1;
  if (expected) operation.expectedErrorCount += 1;
  else operation.unexpectedErrorCount += 1;
}

export function operationReport(operation: OperationMetrics) {
  const total =
    operation.successCount +
    operation.expectedErrorCount +
    operation.unexpectedErrorCount;
  return {
    name: operation.name,
    transport: operation.transport,
    count: total,
    successCount: operation.successCount,
    errorCount: operation.expectedErrorCount + operation.unexpectedErrorCount,
    errorRate: total ? operation.unexpectedErrorCount / total : 0,
    latencyMs: summarize(operation.timingsMs),
    errors: operation.errors,
  };
}
