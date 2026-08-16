import { sessionValidity, absoluteExpiry } from './session-limits';
import { FakeClock } from '../../../common/clock';

describe('session-limits', () => {
  const idleMs = 30 * 60 * 1000;
  const absoluteMs = 8 * 60 * 60 * 1000;

  it('marks a session valid within both idle and absolute windows', () => {
    const clock = new FakeClock(1_000_000);
    const lastSeen = new Date(1_000_000);
    const expiresAt = new Date(1_000_000 + absoluteMs);
    expect(sessionValidity(lastSeen, expiresAt, clock, idleMs)).toEqual({
      valid: true,
      reason: null,
    });
  });

  it('marks expired when the absolute window has passed', () => {
    const clock = new FakeClock(1_000_000 + absoluteMs + 1);
    expect(
      sessionValidity(
        new Date(1_000_000),
        new Date(1_000_000 + absoluteMs),
        clock,
        idleMs,
      ),
    ).toEqual({ valid: false, reason: 'expired' });
  });

  it('marks idle when lastSeenAt is older than the idle window', () => {
    const clock = new FakeClock(1_000_000 + idleMs + 1);
    expect(
      sessionValidity(
        new Date(1_000_000),
        new Date(1_000_000 + absoluteMs),
        clock,
        idleMs,
      ),
    ).toEqual({ valid: false, reason: 'idle' });
  });

  it('absoluteExpiry = now + absoluteMs', () => {
    const clock = new FakeClock(1_000_000);
    expect(absoluteExpiry(clock, absoluteMs)).toEqual(
      new Date(1_000_000 + absoluteMs),
    );
  });
});
