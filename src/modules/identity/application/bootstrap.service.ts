import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Account } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import { newId, hashPassword } from '../../../common/crypto';
import { AccountRole } from '../domain/roles';
import { AccountStatus } from '../domain/account-status';
import {
  validatePassword,
  PasswordPolicyError,
} from '../domain/password-policy';
import {
  ConflictError,
  UnauthorizedError,
  ValidationError,
} from '../../../common/errors';

/**
 * One-time deployment bootstrap: create the first system admin.
 *
 * Authority: only permitted when (a) `system_setting.bootstrap_completed` is
 * not true AND (b) no account with role=admin exists. After success, sets
 * `bootstrap_completed = true` so a second first-admin cannot be created.
 *
 * Concurrency (only-one-wins): the whole operation runs in one transaction
 * that takes a transaction-scoped advisory lock keyed on a fixed string, then
 * re-checks both guard conditions inside the lock before inserting. Two
 * concurrent bootstraps serialize on the lock; the loser sees
 * `bootstrap_completed = true` (or an admin row) and is rejected.
 *
 * Secret delivery: the bootstrap secret arrives via env vars read here, never
 * via command line / shell history (CLI BDD R-C1-2 forbids that for CLI keys;
 * we apply the same posture to the bootstrap password). Interactive stdin /
 * Docker secret is the production target (deferred).
 */
@Injectable()
export class BootstrapService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly tx: TransactionService,
    private readonly config: ConfigService,
  ) {}

  private get db() {
    return this.prismaService.prisma;
  }

  /** True when bootstrap is currently permitted (fresh install). */
  async isPermitted(): Promise<boolean> {
    const flag = await this.db.systemSetting.findUnique({
      where: { key: 'bootstrap_completed' },
    });
    if (flag && (flag.value as { completed?: boolean })?.completed === true) {
      return false;
    }
    const adminCount = await this.db.account.count({
      where: { role: AccountRole.ADMIN },
    });
    return adminCount === 0;
  }

  /**
   * Read bootstrap credentials from env and create the first admin. Throws
   * ConflictError if bootstrap is not permitted (already bootstrapped).
   */
  async bootstrapFromEnv(): Promise<Account> {
    const username = this.config.get<string>('BOOTSTRAP_ADMIN_USERNAME');
    const password = this.config.get<string>('BOOTSTRAP_ADMIN_PASSWORD');
    const displayName =
      this.config.get<string>('BOOTSTRAP_ADMIN_DISPLAY_NAME') ??
      'Administrator';

    if (!username || !password) {
      throw new UnauthorizedError(
        'Bootstrap credentials not provided via env (BOOTSTRAP_ADMIN_USERNAME/PASSWORD)',
      );
    }
    try {
      validatePassword(password);
    } catch (e) {
      if (e instanceof PasswordPolicyError) {
        throw new ValidationError(e.message, 'password');
      }
      throw e;
    }

    return this.createFirstAdmin({ username, displayName, password });
  }

  /**
   * Create the first admin inside an advisory-locked, re-checking transaction.
   * Exposed for direct invocation (e.g. tests) and `bootstrapFromEnv`.
   */
  async createFirstAdmin(input: {
    username: string;
    displayName: string;
    password: string;
  }): Promise<Account> {
    const passwordHash = await hashPassword(input.password);
    const accountId = newId();

    return this.tx.run(async (txClient) => {
      // Transaction-scoped advisory lock serializes concurrent bootstraps.
      // Fixed key: any constant works since only one bootstrap is ever valid.
      // The function returns PostgreSQL `void`, so executeRaw avoids Prisma's
      // result deserialization path for SELECT queries.
      await txClient.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'bootstrap:firstadmin'}))`;

      // Re-check both guards inside the lock.
      const flag = await txClient.systemSetting.findUnique({
        where: { key: 'bootstrap_completed' },
      });
      if (flag && (flag.value as { completed?: boolean })?.completed === true) {
        throw new ConflictError('Bootstrap already completed');
      }
      const adminCount = await txClient.account.count({
        where: { role: AccountRole.ADMIN },
      });
      if (adminCount > 0) {
        throw new ConflictError('An admin account already exists');
      }
      const existing = await txClient.account.findUnique({
        where: { username: input.username },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictError('Username already exists', 'username');
      }

      const admin = await txClient.account.create({
        data: {
          id: accountId,
          username: input.username,
          displayName: input.displayName,
          role: AccountRole.ADMIN,
          status: AccountStatus.ACTIVE,
          canCreateCourse: true,
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
          createdBy: null,
        },
      });

      await txClient.systemSetting.upsert({
        where: { key: 'bootstrap_completed' },
        update: { value: { completed: true } },
        create: {
          id: newId(),
          key: 'bootstrap_completed',
          value: { completed: true },
        },
      });

      return admin;
    });
  }
}
