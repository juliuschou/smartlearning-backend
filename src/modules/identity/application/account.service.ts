import { Injectable, Logger } from '@nestjs/common';
import type { Account } from '../../../../generated/prisma/client';
import { AccountLifecycleBus, SessionService } from '../../../common/auth';
import { isUuid, newId, hashPassword } from '../../../common/crypto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors';
import {
  normalizePageRequest,
  type Page,
  type PageRequest,
  toPage,
} from '../../../common/pagination';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import { ACCOUNT_ROLES, AccountRole, isAccountRole } from '../domain/roles';
import { AccountStatus } from '../domain/account-status';
import {
  validatePassword,
  rejectCommonPassword,
  PasswordPolicyError,
} from '../domain/password-policy';
import { CliCredentialService } from './cli-credential.service';

/**
 * Account write operations. Application layer is the single write entry point
 * — controllers do not touch Prisma.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly tx: TransactionService,
    private readonly sessions: SessionService,
    private readonly cliCredentials: CliCredentialService,
    private readonly accountLifecycleBus: AccountLifecycleBus,
  ) {}

  private get db() {
    return this.prismaService.prisma;
  }

  /**
   * Create an account. Username uniqueness is enforced by the DB; we still
   * pre-check to give a stable, field-scoped conflict error rather than a
   * generic Prisma P2002 leak. The unique constraint is the race authority.
   */
  async createAccount(input: {
    username: string;
    displayName: string;
    role: AccountRole;
    canCreateCourse: boolean;
    tempPassword: string;
    createdBy: string;
  }): Promise<Account> {
    if (!isAccountRole(input.role)) {
      throw new ValidationError(`Invalid role: ${input.role}`, 'role');
    }
    void ACCOUNT_ROLES;
    try {
      validatePassword(input.tempPassword);
      rejectCommonPassword(input.tempPassword);
    } catch (e) {
      if (e instanceof PasswordPolicyError) {
        throw new ValidationError(e.message, 'tempPassword');
      }
      throw e;
    }

    const passwordHash = await hashPassword(input.tempPassword);
    const id = newId();

    return this.tx.run(async (txClient) => {
      const existing = await txClient.account.findUnique({
        where: { username: input.username },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictError('Username already exists', 'username');
      }
      return txClient.account.create({
        data: {
          id,
          username: input.username,
          displayName: input.displayName,
          role: input.role,
          status: AccountStatus.ACTIVE,
          canCreateCourse:
            input.role === AccountRole.STUDENT ? false : input.canCreateCourse,
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: new Date(),
          createdBy: input.createdBy,
        },
      });
    });
  }

  /** Look up an account by username (login path). */
  findByUsername(username: string): Promise<Account | null> {
    return this.db.account.findUnique({ where: { username } });
  }

  findById(id: string): Promise<Account | null> {
    return this.db.account.findUnique({ where: { id } });
  }

  /**
   * Admin account list (metadata only — see `AccountDto` projection). Uses the
   * shared `Page<T>`/`normalizePageRequest`/`toPage` pagination helpers so the
   * wire shape matches the courses contract.
   */
  async listAccounts(raw: {
    page?: number;
    pageSize?: number;
  }): Promise<Page<Account>> {
    const req: PageRequest = normalizePageRequest(raw);
    const [data, total] = await Promise.all([
      this.db.account.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (req.page - 1) * req.pageSize,
        take: req.pageSize,
      }),
      this.db.account.count(),
    ]);
    return toPage(data, total, req);
  }

  /** Account detail (metadata only). */
  async getAccountById(id: string): Promise<Account> {
    const account = await this.db.account.findUnique({ where: { id } });
    if (!account) throw new NotFoundError('Account not found');
    return account;
  }

  async resetPassword(
    targetAccountId: string,
    tempPassword: string,
    actorAccountId: string,
  ): Promise<Account> {
    this.assertNotSelfTarget(targetAccountId, actorAccountId);
    this.validatePasswordOrThrow(tempPassword, 'tempPassword');
    const passwordHash = await hashPassword(tempPassword);

    return this.tx.run(async (txClient) => {
      await this.tx.lockAccountForUpdate(txClient, targetAccountId);
      const target = await txClient.account.findUnique({
        where: { id: targetAccountId },
      });
      if (!target) throw new NotFoundError('Account not found');

      const updated = await txClient.account.update({
        where: { id: targetAccountId },
        data: {
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: new Date(),
        },
      });
      await this.sessions.revokeAllForAccountInTransaction(
        txClient,
        targetAccountId,
      );
      return updated;
    });
  }

  async disableAccount(
    targetAccountId: string,
    actorAccountId: string,
  ): Promise<Account> {
    this.assertNotSelfTarget(targetAccountId, actorAccountId);

    const result = await this.tx.run(async (txClient) => {
      await this.tx.lockAccountForUpdate(txClient, targetAccountId);
      const target = await txClient.account.findUnique({
        where: { id: targetAccountId },
      });
      if (!target) throw new NotFoundError('Account not found');
      if (target.status === AccountStatus.DISABLED) {
        await this.sessions.revokeAllForAccountInTransaction(
          txClient,
          targetAccountId,
        );
        await this.cliCredentials.revokeAllForAccountInTransaction(
          txClient,
          targetAccountId,
        );
        await this.invalidateTokensForAccountInTransaction(
          txClient,
          targetAccountId,
        );
        return { account: target, transitioned: false };
      }

      const updated = await txClient.account.update({
        where: { id: targetAccountId },
        data: {
          status: AccountStatus.DISABLED,
          disabledAt: new Date(),
        },
      });
      await this.sessions.revokeAllForAccountInTransaction(
        txClient,
        targetAccountId,
      );
      await this.cliCredentials.revokeAllForAccountInTransaction(
        txClient,
        targetAccountId,
      );
      await this.invalidateTokensForAccountInTransaction(
        txClient,
        targetAccountId,
      );
      return { account: updated, transitioned: true };
    });

    // Commit-then-publish: only a true ACTIVE → DISABLED transition fans out
    // the account lifecycle signal (re-disabling an already-disabled account
    // is a no-op re-cleanup). Fire-and-forget — a bus failure is logged and
    // must never fail an already-committed mutation.
    if (result.transitioned) {
      this.publishAccountDisabled(targetAccountId);
    }
    return result.account;
  }

  /** Post-commit, fire-and-forget lifecycle signal publish (US-F8). */
  private publishAccountDisabled(accountId: string): void {
    void this.accountLifecycleBus
      .publish({
        type: 'account.disabled',
        accountId,
        timestamp: new Date().toISOString(),
      })
      .catch((error) => {
        this.logger.error(
          {
            accountId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Account lifecycle publish failed; mutation already committed',
        );
      });
  }

  /**
   * Invalidate unconsumed validation tokens for an account (used during
   * disable). Sets consumedAt so they cannot be confirmed; M2 requires
   * account disable to invalidate unused tokens.
   */
  private async invalidateTokensForAccountInTransaction(
    tx: import('../../../../generated/prisma/client').Prisma.TransactionClient,
    accountId: string,
  ): Promise<void> {
    await tx.questionValidationToken.updateMany({
      where: {
        accountId,
        consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
  }

  async restoreAccount(
    targetAccountId: string,
    actorAccountId: string,
  ): Promise<Account> {
    this.assertNotSelfTarget(targetAccountId, actorAccountId);

    return this.tx.run(async (txClient) => {
      await this.tx.lockAccountForUpdate(txClient, targetAccountId);
      const target = await txClient.account.findUnique({
        where: { id: targetAccountId },
      });
      if (!target) throw new NotFoundError('Account not found');
      if (target.status === AccountStatus.ACTIVE) return target;

      return txClient.account.update({
        where: { id: targetAccountId },
        data: {
          status: AccountStatus.ACTIVE,
          disabledAt: null,
        },
      });
    });
  }

  private assertNotSelfTarget(
    targetAccountId: string,
    actorAccountId: string,
  ): void {
    if (!isUuid(targetAccountId)) {
      throw new NotFoundError('Account not found');
    }
    if (targetAccountId.toLowerCase() === actorAccountId.toLowerCase()) {
      throw new ForbiddenError('Use the self-service password operation');
    }
  }

  private validatePasswordOrThrow(password: string, field: string): void {
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
