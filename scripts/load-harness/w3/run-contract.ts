import { randomUUID } from 'node:crypto';

export function createW3RunId(explicit?: string): string {
  const runId = explicit?.trim() || randomUUID();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(runId))
    throw new Error('W3 run ID must contain only bounded run-safe characters.');
  return runId;
}

export function requireW3RunId(value: string | undefined): string {
  if (!value) throw new Error('W3_RUN_ID is required for trace diagnostics.');
  return createW3RunId(value);
}

/** Build the shared environment contract for backend, fixture, and driver. */
export function w3RunEnvironment(
  runId: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const authoritativeRunId = createW3RunId(runId);
  return {
    ...baseEnv,
    W3_RUN_ID: authoritativeRunId,
    REALTIME_TRACE_RUN_ID: authoritativeRunId,
    W3_TRACE_REQUIRED: '1',
  };
}
