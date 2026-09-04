/**
 * Time abstraction so domain logic (session idle/absolute expiry, 8h auto-close,
 * retention 90d) depends on an injectable clock and tests can fake it.
 * All timestamps are UTC milliseconds (epoch).
 */
export const CLOCK = Symbol('CLOCK');

export interface Clock {
  now(): Date;
  nowMs(): number;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  nowMs(): number {
    return Date.now();
  }
}

/**
 * Fake clock for tests. Never use SystemClock in production code that
 * branches on time — inject Clock instead.
 */
export class FakeClock implements Clock {
  constructor(private ms: number) {}

  setMs(ms: number): void {
    this.ms = ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }

  now(): Date {
    return new Date(this.ms);
  }
  nowMs(): number {
    return this.ms;
  }
}
