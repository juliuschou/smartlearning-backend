import { Injectable } from '@nestjs/common';
import type { Account, WebSession } from '../../../../generated/prisma/client';
import { SessionService, type SessionMeta } from '../../../common/auth';
import { hashPassword, verifyPassword } from '../../../common/crypto';
import {
  InvalidCredentialsError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from '../../../common/errors';
import { TransactionService } from '../../../prisma/transaction.service';
import {
  normalizeRateLimitAccountKey,
  RateLimiterService,
} from '../../rate-limit/rate-limiter.service';
import { AccountStatus } from '../domain/account-status';
import {
  PasswordPolicyError,
  validatePassword,
  rejectCommonPassword,
} from '../domain/password-policy';
import { AccountService } from './account.service';

/**
 * Login, step-up, password lifecycle, and current-session operations.
 * All password failures remain generic to preserve anti-enumeration behavior.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
    private readonly transactions: TransactionService,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  /**
   * Validate credentials and create a session. Throws UnauthorizedError on
   * any failure. Returns the raw cookie token + the session + account.
   */
  async login(
    username: string,
    password: string,
    meta?: SessionMeta,
  ): Promise<{ token: string; session: WebSession; account: Account }> {
    // R-F7-7: dual-scope (account + source) login rate limit. Check BEFORE the
    // credential path. The decision is identical whether the account exists, so
    // surfacing `RATE_LIMITED` here leaks no account existence. The source key
    // is the client IP; 'unknown' is a stable fallback when no IP is available
    // (e.g. tests without a proxy), so such callers share one source budget.
    const accountKey = normalizeRateLimitAccountKey(username);
    const sourceKey = meta?.ipAddress ?? 'unknown';
    const limit = this.rateLimiter.check(accountKey, sourceKey);
    if (limit.limited) {
      throw new RateLimitedError(limit.retryAfterSeconds);
    }

    const account = await this.accounts.findByUsername(username);

    // Constant-ish path: always verify against a real hash when present, and
    // against a dummy hash when the account is missing, to avoid timing oracle
    // on account existence. Verify before taking the row lock so repeated
    // wrong-password attempts do not hold a database connection while Argon2
    // runs; the short transaction below rejects any credential/status change
    // observed after that verification.
    if (!account) {
      await verifyDummy(password);
      this.recordLoginFailure(accountKey, sourceKey);
      throw new InvalidCredentialsError();
    }

    const ok = account.passwordHash
      ? await verifySafely(account.passwordHash, password)
      : await verifyDummy(password);
    if (
      !account.passwordHash ||
      !ok ||
      account.status !== AccountStatus.ACTIVE
    ) {
      this.recordLoginFailure(accountKey, sourceKey);
      throw new InvalidCredentialsError();
    }

    try {
      const result = await this.transactions.run(async (txClient) => {
        await this.transactions.lockAccountForUpdate(txClient, account.id);
        const current = await txClient.account.findUnique({
          where: { id: account.id },
        });
        if (
          !current ||
          current.status !== AccountStatus.ACTIVE ||
          current.passwordHash !== account.passwordHash
        ) {
          throw new InvalidCredentialsError();
        }

        const { token, session } =
          await this.sessions.createSessionInTransaction(
            txClient,
            current,
            meta,
          );
        return { token, session, account: current };
      });
      // Success: clear the account-scope counter (source scope decays via TTL).
      this.rateLimiter.clearOnSuccess(accountKey);
      return result;
    } catch (e) {
      if (e instanceof InvalidCredentialsError) {
        this.recordLoginFailure(accountKey, sourceKey);
      }
      throw e;
    }
  }

  /** Record a failed login on both scopes (R-F7-7). */
  private recordLoginFailure(accountKey: string, sourceKey: string): void {
    this.rateLimiter.recordFailure(accountKey, sourceKey);
  }

  async stepUp(
    accountId: string,
    sessionId: string,
    password: string,
  ): Promise<Date> {
    const account = await this.accounts.findById(accountId);
    if (
      !account ||
      account.status !== AccountStatus.ACTIVE ||
      !account.passwordHash ||
      !(await verifySafely(account.passwordHash, password))
    ) {
      throw new InvalidCredentialsError();
    }
    return this.sessions.markStepUp(accountId, sessionId);
  }

  async changePassword(input: {
    accountId: string;
    sessionId: string;
    currentPassword: string;
    newPassword: string;
    sessionMeta?: SessionMeta;
  }): Promise<{ token: string; session: WebSession; account: Account }> {
    this.validatePassword(input.newPassword, 'newPassword');

    const account = await this.accounts.findById(input.accountId);
    if (
      !account ||
      account.status !== AccountStatus.ACTIVE ||
      !account.passwordHash ||
      !(await verifySafely(account.passwordHash, input.currentPassword))
    ) {
      throw new InvalidCredentialsError();
    }
    if (await verifySafely(account.passwordHash, input.newPassword)) {
      throw new ValidationError(
        'New password must differ from the current password',
        'newPassword',
      );
    }
    const newPasswordHash = await hashPassword(input.newPassword);

    return this.transactions.run(async (txClient) => {
      await this.transactions.lockAccountForUpdate(txClient, input.accountId);
      const activeSession = await txClient.webSession.findFirst({
        where: {
          id: input.sessionId,
          accountId: input.accountId,
          revokedAt: null,
        },
        select: { id: true },
      });
      if (!activeSession) throw new UnauthorizedError();
      const current = await txClient.account.findUnique({
        where: { id: input.accountId },
      });
      if (
        !current ||
        current.status !== AccountStatus.ACTIVE ||
        !current.passwordHash ||
        !(await verifySafely(current.passwordHash, input.currentPassword))
      ) {
        throw new InvalidCredentialsError();
      }
      if (await verifySafely(current.passwordHash, input.newPassword)) {
        throw new ValidationError(
          'New password must differ from the current password',
          'newPassword',
        );
      }
      const updated = await txClient.account.update({
        where: { id: input.accountId },
        data: {
          passwordHash: newPasswordHash,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
        },
      });
      const rotated = await this.sessions.rotateAfterCredentialChange(
        txClient,
        { id: input.accountId },
        input.sessionMeta,
      );
      return { ...rotated, account: updated };
    });
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revokeSession(sessionId);
  }

  private validatePassword(password: string, field: string): void {
    try {
      validatePassword(password);
      rejectCommonPassword(password);
    } catch (e) {
      if (e instanceof PasswordPolicyError) {
        throw new ValidationError(e.message, field);
      }
      throw e;
    }
  }
}

async function verifySafely(hash: string, password: string): Promise<boolean> {
  try {
    return await verifyPassword(hash, password);
  } catch {
    return false;
  }
}

// A stable dummy hash so the missing-account path does the same Argon2id work
// as the present-account path. Generated once with Argon2id m=64MiB t=3 p=1.
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function verifyDummy(password: string): Promise<boolean> {
  try {
    await verifyPassword(DUMMY_HASH, password);
  } catch {
    // Hash is malformed; ignore — the result is false either way.
  }
  return false;
}
