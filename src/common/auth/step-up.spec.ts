import { isStepUpValid, STEP_UP_DURATION_MS, stepUpExpiresAt } from './step-up';

describe('step-up validity', () => {
  const markedAt = new Date('2026-08-16T00:00:00.000Z');

  it('is valid from the mark through just before the ten-minute boundary', () => {
    expect(isStepUpValid(markedAt, markedAt.getTime())).toBe(true);
    expect(
      isStepUpValid(markedAt, markedAt.getTime() + STEP_UP_DURATION_MS - 1),
    ).toBe(true);
  });

  it('fails before the mark, at expiry, and after expiry', () => {
    expect(isStepUpValid(markedAt, markedAt.getTime() - 1)).toBe(false);
    expect(
      isStepUpValid(markedAt, markedAt.getTime() + STEP_UP_DURATION_MS),
    ).toBe(false);
    expect(
      isStepUpValid(markedAt, markedAt.getTime() + STEP_UP_DURATION_MS + 1),
    ).toBe(false);
  });

  it('rejects a future timestamp and exposes only a safe expiry projection', () => {
    expect(isStepUpValid(markedAt, markedAt.getTime() - 1)).toBe(false);
    expect(stepUpExpiresAt(markedAt).toISOString()).toBe(
      '2026-08-16T00:10:00.000Z',
    );
  });
});
