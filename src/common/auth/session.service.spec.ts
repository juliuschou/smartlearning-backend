import { ConfigService } from '@nestjs/config';
import { FakeClock } from '../clock';
import { hashToken } from '../crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionService } from '../../prisma/transaction.service';
import { AccountStatus } from '../../modules/identity/domain/account-status';
import { AccountRole } from '../../modules/identity/domain/roles';
import { SessionService } from './session.service';
import { SessionExpiredError, UnauthorizedError } from '../errors';

/**
 * Unit tests for SessionService.loadActiveSession — the frozen BE-8.1 CP1
 * contract: idle/absolute expiry → SessionExpiredError (same code), while
 * revoked / disabled / missing-hash stay UnauthorizedError. Uses a FakeClock
 * so the idle/absolute windows are deterministic.
 */
describe('SessionService.loadActiveSession', () => {
  const IDLE_MS = 30 * 60 * 1000;
  const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
  const NOW = new Date('2026-08-30T12:00:00.000Z').getTime();

  let clock: FakeClock;
  let sessions: SessionService;
  let prisma: {
    prisma: {
      webSession: {
        findUnique: jest.Mock;
        update: jest.Mock;
      };
    };
  };

  const account = {
    id: 'account-1',
    username: 'teacher',
    displayName: 'Teacher',
    role: AccountRole.TEACHER,
    status: AccountStatus.ACTIVE,
    canCreateCourse: true,
    mustChangePassword: false,
  };

  function sessionRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'session-1',
      accountId: account.id,
      cookieHash: hashToken('raw-token'),
      lastSeenAt: new Date(NOW),
      expiresAt: new Date(NOW + ABSOLUTE_MS),
      revokedAt: null,
      stepUpAt: null,
      account,
      ...overrides,
    };
  }

  beforeEach(() => {
    clock = new FakeClock(NOW);
    prisma = {
      prisma: {
        webSession: {
          findUnique: jest.fn(),
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'SESSION_IDLE_MS') return IDLE_MS;
        if (key === 'SESSION_ABSOLUTE_MS') return ABSOLUTE_MS;
        return undefined;
      }),
    } as unknown as ConfigService;
    sessions = new SessionService(
      prisma as unknown as PrismaService,
      config,
      {} as TransactionService,
      clock,
    );
  });

  it('returns the session+account and touches lastSeenAt for a valid session', async () => {
    prisma.prisma.webSession.findUnique.mockResolvedValue(sessionRow());

    const result = await sessions.loadActiveSession('raw-token');

    expect(result.session.id).toBe('session-1');
    expect(result.account.id).toBe('account-1');
    expect(prisma.prisma.webSession.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { lastSeenAt: new Date(NOW) },
    });
  });

  it('throws SessionExpiredError when the absolute window has passed', async () => {
    prisma.prisma.webSession.findUnique.mockResolvedValue(
      sessionRow({ expiresAt: new Date(NOW - 1) }),
    );

    await expect(
      sessions.loadActiveSession('raw-token'),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    await expect(sessions.loadActiveSession('raw-token')).rejects.toMatchObject(
      {
        code: 'AUTH_SESSION_EXPIRED',
        httpStatus: 401,
      },
    );
  });

  it('throws SessionExpiredError (same code) when the idle window has passed', async () => {
    // expiresAt still in the future, but lastSeenAt + idleMs is in the past.
    prisma.prisma.webSession.findUnique.mockResolvedValue(
      sessionRow({
        lastSeenAt: new Date(NOW - IDLE_MS - 1),
        expiresAt: new Date(NOW + ABSOLUTE_MS),
      }),
    );

    await expect(
      sessions.loadActiveSession('raw-token'),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    await expect(sessions.loadActiveSession('raw-token')).rejects.toMatchObject(
      {
        code: 'AUTH_SESSION_EXPIRED',
      },
    );
  });

  it('throws UnauthorizedError for a revoked session (logged-out ≠ expired)', async () => {
    prisma.prisma.webSession.findUnique.mockResolvedValue(
      sessionRow({ revokedAt: new Date(NOW - 1000) }),
    );

    await expect(
      sessions.loadActiveSession('raw-token'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(sessions.loadActiveSession('raw-token')).rejects.toMatchObject(
      {
        code: 'UNAUTHORIZED',
      },
    );
  });

  it('throws UnauthorizedError for a disabled account', async () => {
    prisma.prisma.webSession.findUnique.mockResolvedValue(
      sessionRow({
        account: { ...account, status: AccountStatus.DISABLED },
      }),
    );

    await expect(
      sessions.loadActiveSession('raw-token'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(sessions.loadActiveSession('raw-token')).rejects.toMatchObject(
      {
        code: 'UNAUTHORIZED',
      },
    );
  });

  it('throws UnauthorizedError when no session matches the token hash', async () => {
    prisma.prisma.webSession.findUnique.mockResolvedValue(null);

    await expect(
      sessions.loadActiveSession('raw-token'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(sessions.loadActiveSession('raw-token')).rejects.toMatchObject(
      {
        code: 'UNAUTHORIZED',
      },
    );
  });
});
