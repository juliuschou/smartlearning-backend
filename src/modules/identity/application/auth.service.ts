import { Injectable } from '@nestjs/common';
import type { Account, WebSession } from '../../../../generated/prisma/client';
import { AccountService } from './account.service';
import { SessionService } from '../../../common/auth';
import { verifyPassword } from '../../../common/crypto';
import { AccountStatus } from '../domain/account-status';
import { InvalidCredentialsError } from '../../../common/errors';

/**
 * Login + current-session resolution.
 *
 * Generic failure: every failure path — missing account, wrong password,
 * disabled account — returns the same AUTH_INVALID_CREDENTIALS 401 so account
 * existence is not disclosed (P0-03 防 enumeration). No rate limit in this
 * slice (deferred — recorded as a security gap).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Validate credentials and create a session. Throws UnauthorizedError on
   * any failure. Returns the raw cookie token + the session + account.
   */
  async login(
    username: string,
    password: string,
    meta?: { ipAddress?: string; userAgent?: string },
  ): Promise<{ token: string; session: WebSession; account: Account }> {
    const account = await this.accounts.findByUsername(username);

    // Constant-ish path: always verify against a real hash when present, and
    // against a dummy hash when the account is missing, to avoid timing oracle
    // on account existence.
    const ok = account?.passwordHash
      ? await verifyPassword(account.passwordHash, password)
      : await verifyDummy(password);

    if (!account || !account.passwordHash || !ok) {
      throw new InvalidCredentialsError();
    }
    if (account.status !== AccountStatus.ACTIVE) {
      throw new InvalidCredentialsError();
    }

    const { token, session } = await this.sessions.createSession(account, meta);
    return { token, session, account };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revokeSession(sessionId);
  }
}

// A stable dummy hash so the missing-account path does the same Argon2id work
// as the present-account path. Generated once with Argon2id m=64MiB t=3 p=1.
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function verifyDummy(_password: string): Promise<boolean> {
  // Always returns false; the work is done to match timing.
  try {
    await verifyPassword(DUMMY_HASH, _password);
  } catch {
    // Hash is malformed; ignore — the result is false either way.
  }
  return false;
}
