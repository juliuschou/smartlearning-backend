import {
  LeaseLostError,
  classifyPurgeFailure,
  decidePurgeFailure,
  retryDelayMs,
} from './purge-failure-policy';
import { Prisma } from '../../../../generated/prisma/client';

describe('purge-failure-policy', () => {
  describe('classifyPurgeFailure', () => {
    it('maps an explicit DB-unavailable signal to unavailable_db', () => {
      expect(classifyPurgeFailure(new Error('connection reset'), true)).toBe(
        'unavailable_db',
      );
    });

    it('maps a lost lease to lease_lost', () => {
      expect(classifyPurgeFailure(new LeaseLostError())).toBe('lease_lost');
    });

    it('maps Prisma P1001/P1002 connect timeouts to unavailable_db', () => {
      for (const code of ['P1001', 'P1002']) {
        const err = new Prisma.PrismaClientKnownRequestError(
          'cannot reach database',
          { code, clientVersion: '5' },
        );
        expect(classifyPurgeFailure(err)).toBe('unavailable_db');
      }
    });

    it('maps P2003 FK violations to fk_blocker', () => {
      const err = new Prisma.PrismaClientKnownRequestError('fk', {
        code: 'P2003',
        clientVersion: '5',
      });
      expect(classifyPurgeFailure(err)).toBe('fk_blocker');
    });

    it('maps other P2xxx engine errors to transient_db', () => {
      const err = new Prisma.PrismaClientKnownRequestError('serialization', {
        code: 'P2034',
        clientVersion: '5',
      });
      expect(classifyPurgeFailure(err)).toBe('transient_db');
    });

    it('maps anything else to unknown', () => {
      expect(classifyPurgeFailure('weird')).toBe('unknown');
      expect(classifyPurgeFailure(new Error('boom'))).toBe('unknown');
    });
  });

  describe('decision / backoff', () => {
    it('quarantines permanent codes on the first attempt', () => {
      for (const code of [
        'invariant_conflict',
        'fk_blocker',
        'lease_lost',
      ] as const) {
        expect(decidePurgeFailure(code, 1, 5)).toEqual({
          quarantined: true,
          reason: 'permanent',
        });
      }
    });

    it('quarantines transient failures once attempts exhaust the budget', () => {
      expect(decidePurgeFailure('transient_db', 5, 5)).toEqual({
        quarantined: true,
        reason: 'exhausted',
      });
    });

    it('retries transient failures with bounded exponential backoff', () => {
      expect(decidePurgeFailure('unknown', 1, 5)).toEqual({
        quarantined: false,
        delayMs: 250,
      });
      expect(decidePurgeFailure('unknown', 2, 5)).toEqual({
        quarantined: false,
        delayMs: 500,
      });
    });

    it('caps the retry delay', () => {
      // attempt 9 → 250 * 2^8 = 64000 > cap 30000
      expect(retryDelayMs('unknown', 9, 250, 30_000)).toBe(30_000);
      expect(retryDelayMs('unknown', 5, 250, 30_000)).toBe(4_000);
    });
  });
});
