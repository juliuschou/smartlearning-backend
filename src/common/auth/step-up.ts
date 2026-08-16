/**
 * Server-side password step-up lifetime. The state is stored on WebSession,
 * never supplied by the client, and is valid for exactly ten minutes.
 */
export const STEP_UP_DURATION_MS = 10 * 60 * 1000;

export function isStepUpValid(
  stepUpAt: Date | null | undefined,
  nowMs: number,
  durationMs = STEP_UP_DURATION_MS,
): boolean {
  if (!stepUpAt) return false;
  const markedAt = stepUpAt.getTime();
  return markedAt <= nowMs && nowMs < markedAt + durationMs;
}

export function stepUpExpiresAt(
  stepUpAt: Date,
  durationMs = STEP_UP_DURATION_MS,
): Date {
  return new Date(stepUpAt.getTime() + durationMs);
}
