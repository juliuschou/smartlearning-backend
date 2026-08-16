import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WebSession, Account } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Clock, SystemClock } from '../clock';
import { generateToken, hashToken, newId } from '../crypto';
import {
  sessionValidity,
  absoluteExpiry,
} from '../../modules/identity/domain/session-limits';
import { AccountStatus } from '../../modules/identity/domain/account-status';
import { UnauthorizedError } from '../errors';

/**
 * Web Session lifecycle: create, load (cookie → hash → DB), touch idle clock.
 * PostgreSQL is the single authority — only the SHA-256 hash of the opaque
 * token is persisted; the raw token lives only in the cookie (M2 §4).
 *
 * Slice scope: create on login, load+touch on every guarded request. Logout/
 * rotation/full revocation are deferred.
 */
@Injectable()
export class SessionService {
  private readonly clock: Clock;
  private readonly idleMs: number;
  private readonly absoluteMs: number;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly config: ConfigService,
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

  /**
   * Create a session for an account. Returns the raw token (to set in the
   * cookie) and the persisted DB row.
   */
  async createSession(
    account: Pick<Account, 'id'>,
    meta?: { ipAddress?: string; userAgent?: string },
  ): Promise<{ token: string; session: WebSession }> {
    const token = generateToken();
    const cookieHash = hashToken(token);
    const session = await this.db.webSession.create({
      data: {
        id: newId(),
        accountId: account.id,
        cookieHash,
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
        lastSeenAt: new Date(this.clock.nowMs()),
        expiresAt: absoluteExpiry(this.clock, this.absoluteMs),
      },
    });
    return { token, session };
  }

  /**
   * Resolve a raw cookie token to a valid, active session + account.
   * Throws UnauthorizedError if the token has no session, the session is
   * expired/idle/revoked, or the account is no longer active.
   * Touches lastSeenAt on success.
   */
  async loadActiveSession(rawToken: string): Promise<{
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
      throw new UnauthorizedError();
    }
    if (session.revokedAt) {
      throw new UnauthorizedError();
    }
    const { valid } = sessionValidity(
      session.lastSeenAt,
      session.expiresAt,
      this.clock,
      this.idleMs,
    );
    if (!valid) {
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
