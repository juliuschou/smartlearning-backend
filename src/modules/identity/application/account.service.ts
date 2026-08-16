import { Injectable } from '@nestjs/common';
import { Account } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import { newId, hashPassword } from '../../../common/crypto';
import { ACCOUNT_ROLES, AccountRole, isAccountRole } from '../domain/roles';
import { AccountStatus } from '../domain/account-status';
import {
  validatePassword,
  PasswordPolicyError,
} from '../domain/password-policy';
import { ConflictError, ValidationError } from '../../../common/errors';

/**
 * Account write operations. Application layer is the single write entry point
 * — controllers do not touch Prisma directly.
 *
 * Slice scope: admin creates teacher/admin accounts. Disable/restore is
 * deferred.
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly tx: TransactionService,
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
    void ACCOUNT_ROLES; // referenced for exhaustiveness intent
    try {
      validatePassword(input.tempPassword);
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
          canCreateCourse: input.canCreateCourse,
          passwordHash,
          // Slice: no forced first-login change.
          mustChangePassword: false,
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
}
