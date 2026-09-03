import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  type WebSession,
  type Account,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionService } from '../../prisma/transaction.service';
import { Clock, SystemClock } from '../clock';
import { generateToken, hashToken, newId } from '../crypto';
import {
  sessionValidity,
  absoluteExpiry,
} from '../../modules/identity/domain/session-limits';
import { AccountStatus } from '../../modules/identity/domain/account-status';
import {
  AccountDisabledError,
  SessionExpiredError,
  StepUpRequiredError,
  UnauthorizedError,
} from '../errors';
import { isStepUpValid } from './step-up';

export type SessionMeta = {
  ipAddress?: string;
  userAgent?: string;
};

/**
 * Web Session lifecycle: create, load (cookie → hash → DB), touch idle clock,
 * step-up state, rotation, and account-wide revocation. PostgreSQL is the
 * single authority — only the SHA-256 hash of the opaque token is persisted;
 * raw tokens live only in cookies (M2 §4).
 */
@Injectable()
export class SessionService {
  private readonly clock: Clock;
  private readonly idleMs: number;
  private readonly absoluteMs: number;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly config: ConfigService,
    private readonly transactions: TransactionService,
    @Optional() clock?: Clock,
  ) {
    this.clock = clock ?? new SystemClock();
    this.idleMs = config.get<number>('SESSION_IDLE_MS') ?? 30 * 60 * 1000;
    this.absoluteMs =
      config.get<number>('SESSION_ABSOLUTE_MS') ?? 8 * 60 * 60 * 1000;
  }

  private get db() {
    return this.prismaService.prisma;
  }

  /** Create a session for an account and return its raw cookie token once. */
  async createSession(
    account: Pick<Account, 'id'>,
    meta?: SessionMeta,
  ): Promise<{ token: string; session: WebSession }> {
    return this.transactions.run(async (tx) => {
      await this.transactions.lockAccountForUpdate(tx, account.id);
      const current = await tx.account.findUnique({
        where: { id: account.id },
        select: { status: true },
      });
      if (!current || current.status !== AccountStatus.ACTIVE) {
        throw new UnauthorizedError();
      }
      return this.createSessionInTransaction(tx, account, meta);
    });
  }

  /** Create a session inside a caller-owned transaction. */
  async createSessionInTransaction(
    tx: Prisma.TransactionClient,
    account: Pick<Account, 'id'>,
    meta?: SessionMeta,
  ): Promise<{ token: string; session: WebSession }> {
    const token = generateToken();
    const session = await tx.webSession.create({
      data: {
        id: newId(),
        accountId: account.id,
        cookieHash: hashToken(token),
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
        lastSeenAt: new Date(this.clock.nowMs()),
        expiresAt: absoluteExpiry(this.clock, this.absoluteMs),
      },
    });
    return { token, session };
  }

  /** Revoke a session safely when logout is repeated or retried. */
  async revokeSession(sessionId: string): Promise<void> {
    await this.db.webSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(this.clock.nowMs()), stepUpAt: null },
    });
  }

  /** Revoke every active session for an account in a caller-owned transaction. */
  async revokeAllForAccountInTransaction(
    tx: Prisma.TransactionClient,
    accountId: string,
    revokedAt = new Date(this.clock.nowMs()),
  ): Promise<void> {
    await tx.webSession.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt, stepUpAt: null },
    });
  }

  /**
   * Revoke all existing sessions and create a replacement current session in
   * the same transaction. The replacement has no inherited step-up state.
   */
  async rotateAfterCredentialChange(
    tx: Prisma.TransactionClient,
    account: Pick<Account, 'id'>,
    meta?: SessionMeta,
  ): Promise<{ token: string; session: WebSession }> {
    await this.revokeAllForAccountInTransaction(tx, account.id);
    return this.createSessionInTransaction(tx, account, meta);
  }

  /**
   * Mark the current active session as recently step-up authenticated. The
   * account status is rechecked inside the transaction so disabled accounts
   * cannot create a new step-up state during a concurrent disable.
   */
  async markStepUp(accountId: string, sessionId: string): Promise<Date> {
    const markedAt = new Date(this.clock.nowMs());
    await this.transactions.run(async (tx) => {
      await this.transactions.lockAccountForUpdate(tx, accountId);
      const session = await tx.webSession.findFirst({
        where: {
          id: sessionId,
          accountId,
          revokedAt: null,
          account: { status: AccountStatus.ACTIVE },
        },
        select: { id: true },
      });
      if (!session) throw new UnauthorizedError();

      const updated = await tx.webSession.updateMany({
        where: {
          id: session.id,
          accountId,
          revokedAt: null,
        },
        data: { stepUpAt: markedAt },
      });
      if (updated.count !== 1) throw new UnauthorizedError();
    });
    return markedAt;
  }

  /**
   * Leaf account-status check for server-side socket re-authorization (US-F8).
   * Unlike `loadActiveSession`, this does not resolve a session — it only
   * verifies the account row is still `active`, so the gateway can drop
   * teacher/admin sockets whose account was disabled even when the lifecycle
   * signal is missed. Throws UnauthorizedError for a missing or disabled
   * account.
   */
  async assertAccountActive(accountId: string): Promise<void> {
    const account = await this.db.account.findUnique({
      where: { id: accountId },
      select: { status: true },
    });
    if (!account || account.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedError();
    }
  }

  /** Require a non-expired step-up for this exact account/session pair. */
  async assertRecentStepUp(
    accountId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.db.webSession.findFirst({
      where: {
        id: sessionId,
        accountId,
        revokedAt: null,
        account: { status: AccountStatus.ACTIVE },
      },
      select: { stepUpAt: true },
    });
    if (!session || !isStepUpValid(session.stepUpAt, this.clock.nowMs())) {
      throw new StepUpRequiredError();
    }
  }

  /**
   * Resolve a raw cookie token to a valid, active session + account.
   * Throws SessionExpiredError if the session is idle/absolute-expired;
   * throws UnauthorizedError if the token has no session, the session is
   * revoked, or the account is no longer active. Touches lastSeenAt on
   * success.
   */
  async loadActiveSession(
    rawToken: string,
    options: { exposeDisabled?: boolean } = {},
  ): Promise<{
    session: WebSession;
    account: Account;
  }> {
    const cookieHash = hashToken(rawToken);
    const session = await this.db.webSession.findUnique({
      where: { cookieHash },
      include: { account: true },
    });
    if (!session || !session.account) {
      throw new UnauthorizedError();
    }

    const account = session.account;
    if (account.status !== AccountStatus.ACTIVE) {
      if (options.exposeDisabled && account.status === AccountStatus.DISABLED) {
        throw new AccountDisabledError();
      }
      throw new UnauthorizedError();
    }
    if (session.revokedAt) {
      throw new UnauthorizedError();
    }
    const { valid, reason } = sessionValidity(
      session.lastSeenAt,
      session.expiresAt,
      this.clock,
      this.idleMs,
    );
    if (!valid) {
      // Frozen contract: idle and absolute timeouts share the same code
      // (AUTH_SESSION_EXPIRED). `sessionValidity` only returns 'expired' |
      // 'idle' | null; null cannot reach this branch, so the defensive else
      // keeps UnauthorizedError for any unexpected reason.
      if (reason === 'expired' || reason === 'idle') {
        throw new SessionExpiredError();
      }
      throw new UnauthorizedError();
    }

    // Touch idle clock — cheap update, no transaction needed.
    await this.db.webSession.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(this.clock.nowMs()) },
    });

    return { session, account };
  }
}
