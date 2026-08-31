jest.mock('../../../common/crypto', () => ({
  hashPassword: jest.fn(),
  verifyPassword: jest.fn().mockResolvedValue(true),
}));

import { AccountStatus } from '../domain/account-status';
import { RateLimitUnavailableError } from '../../../common/errors';
import { AuthService } from './auth.service';

function makeAuth() {
  const accounts = {
    findByUsername: jest.fn(),
  };
  const sessions = {
    createSessionInTransaction: jest.fn(),
  };
  const transactions = {
    run: jest.fn(),
    lockAccountForUpdate: jest.fn(),
  };
  const rateLimiter = {
    check: jest.fn(),
    recordFailure: jest.fn(),
    clearOnSuccess: jest.fn(),
  };
  return {
    auth: new AuthService(
      accounts as never,
      sessions as never,
      transactions as never,
      rateLimiter as never,
    ),
    accounts,
    sessions,
    transactions,
    rateLimiter,
  };
}

describe('AuthService login rate-limit boundary', () => {
  it('does not look up an account when the limiter is unavailable', async () => {
    const { auth, accounts, rateLimiter } = makeAuth();
    rateLimiter.check.mockRejectedValue(new RateLimitUnavailableError());

    await expect(auth.login('alice', 'password')).rejects.toBeInstanceOf(
      RateLimitUnavailableError,
    );
    expect(accounts.findByUsername).not.toHaveBeenCalled();
  });

  it('surfaces a failure-recording outage instead of returning uncounted 401', async () => {
    const { auth, accounts, rateLimiter } = makeAuth();
    rateLimiter.check.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
    accounts.findByUsername.mockResolvedValue(null);
    rateLimiter.recordFailure.mockRejectedValue(
      new RateLimitUnavailableError(),
    );

    await expect(auth.login('missing', 'password')).rejects.toBeInstanceOf(
      RateLimitUnavailableError,
    );
    expect(rateLimiter.recordFailure).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed login successful when account clear fails', async () => {
    const { auth, accounts, sessions, transactions, rateLimiter } = makeAuth();
    const account = {
      id: 'account-id',
      username: 'alice',
      passwordHash: 'invalid-hash',
      status: AccountStatus.ACTIVE,
    };
    const session = { id: 'session-id' };
    rateLimiter.check.mockResolvedValue({
      limited: false,
      retryAfterSeconds: 0,
    });
    accounts.findByUsername.mockResolvedValue(account);
    sessions.createSessionInTransaction.mockResolvedValue({
      token: 'token',
      session,
    });
    transactions.run.mockImplementation(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          account: { findUnique: jest.fn().mockResolvedValue(account) },
        }),
    );
    rateLimiter.clearOnSuccess.mockRejectedValue(
      new RateLimitUnavailableError(),
    );

    await expect(auth.login('alice', 'password')).resolves.toEqual({
      token: 'token',
      session,
      account,
    });
  });
});
