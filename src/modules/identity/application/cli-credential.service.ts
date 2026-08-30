import { Injectable } from '@nestjs/common';
import type { CliCredential } from '../../../../generated/prisma/client';
import {
  generateToken,
  hashToken,
  isUuid,
  newId,
} from '../../../common/crypto';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
} from '../../../common/errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import { AccountStatus } from '../domain/account-status';
import {
  CliCredentialScope,
  CliCredentialStatus,
} from '../domain/cli-credential-status';

/**
 * CLI credential principal attached to the request by CliAuthGuard.
 * Mirrors AuthContext shape but carries a credentialId instead of a sessionId.
 */
export interface CliAuthContext {
  account: {
    id: string;
    username: string;
    displayName: string;
    role: string;
    status: string;
    canCreateCourse: boolean;
    mustChangePassword: boolean;
  };
  credentialId: string;
  scope: string;
}

export type CliCredentialProjection = Omit<CliCredential, 'keyHash'>;

@Injectable()
export class CliCredentialService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly transactions: TransactionService,
  ) {}

  private get db() {
    return this.prismaService.prisma;
  }

  /**
   * Create a CLI credential. The raw key is returned only here and never
   * persisted or logged. Key ops require a recent step-up (enforced at the
   * controller/guard layer).
   */
  async createCredential(
    accountId: string,
    name: string,
  ): Promise<{
    credential: CliCredentialProjection;
    rawKey: string;
  }> {
    return this.transactions.run(async (tx) => {
      await this.transactions.lockAccountForUpdate(tx, accountId);
      const account = await tx.account.findUnique({
        where: { id: accountId },
        select: { id: true, status: true },
      });
      if (!account) {
        throw new NotFoundError('Account not found', 'id');
      }
      // A disabled account must not receive a new active key that could be
      // resurrected by a later restore (R-F8-2). The account row lock (taken
      // above) serializes this against a concurrent disable.
      if (account.status !== AccountStatus.ACTIVE) {
        throw new ForbiddenError('Account is not active.');
      }
      // Pre-check name uniqueness for a stable field-scoped conflict; the DB
      // unique constraint remains the race authority.
      const existing = await tx.cliCredential.findUnique({
        where: { accountId_name: { accountId, name } },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictError(
          'A CLI credential with this name already exists for the account.',
          'name',
        );
      }
      const rawKey = generateToken();
      const keyHash = hashToken(rawKey);
      const credential = await tx.cliCredential.create({
        data: {
          id: newId(),
          accountId,
          name,
          keyHash,
          scope: CliCredentialScope.ALL_COURSES,
          status: CliCredentialStatus.ACTIVE,
        },
      });
      const { keyHash: _omit, ...projection } = credential;
      void _omit;
      return { credential: projection, rawKey };
    });
  }

  /** List credentials for an account (metadata only; no key hash). */
  async listCredentials(accountId: string): Promise<CliCredentialProjection[]> {
    const credentials = await this.db.cliCredential.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
    return credentials.map(({ keyHash: _omit, ...rest }) => {
      void _omit;
      return rest;
    });
  }

  /**
   * Rotate an active credential immediately. The predecessor is retained as a
   * revoked archival row while the successor reuses its logical name.
   */
  async rotateCredential(
    accountId: string,
    credentialId: string,
  ): Promise<{
    credential: CliCredentialProjection;
    rawKey: string;
  }> {
    const rawKey = generateToken();
    const keyHash = hashToken(rawKey);

    return this.transactions.run(async (tx) => {
      await this.transactions.lockAccountForUpdate(tx, accountId);
      const account = await tx.account.findUnique({
        where: { id: accountId },
        select: { id: true, status: true },
      });
      if (!account) {
        throw new NotFoundError('Account not found', 'id');
      }
      if (account.status !== AccountStatus.ACTIVE) {
        throw new ForbiddenError('Account is not active.');
      }

      const predecessor = await tx.cliCredential.findUnique({
        where: { id: credentialId },
        include: { rotatedTo: { select: { id: true } } },
      });
      if (!predecessor || predecessor.accountId !== accountId) {
        throw new NotFoundError('CLI credential not found', 'credentialId');
      }
      if (
        predecessor.status !== CliCredentialStatus.ACTIVE ||
        predecessor.rotatedTo
      ) {
        throw new ConflictError(
          'CLI credential has already been revoked or rotated.',
          'credentialId',
        );
      }

      const now = new Date();
      const originalName = predecessor.name;
      const archivalName = `${Array.from(originalName).slice(0, 18).join('')}~rotated~${predecessor.id}`;
      await tx.cliCredential.update({
        where: { id: predecessor.id },
        data: {
          name: archivalName,
          status: CliCredentialStatus.REVOKED,
          revokedAt: now,
        },
      });

      const successor = await tx.cliCredential.create({
        data: {
          id: newId(),
          accountId,
          name: originalName,
          keyHash,
          scope: predecessor.scope,
          status: CliCredentialStatus.ACTIVE,
          rotatedFromId: predecessor.id,
          createdAt: now,
        },
      });
      const { keyHash: _omit, ...projection } = successor;
      void _omit;
      return { credential: projection, rawKey };
    });
  }

  /** Revoke a credential. Idempotent for already-revoked keys. */
  async revokeCredential(
    accountId: string,
    credentialId: string,
  ): Promise<void> {
    await this.transactions.run(async (tx) => {
      await this.transactions.lockAccountForUpdate(tx, accountId);
      const credential = await tx.cliCredential.findUnique({
        where: { id: credentialId },
      });
      if (!credential || credential.accountId !== accountId) {
        throw new NotFoundError('CLI credential not found', 'credentialId');
      }
      if (credential.status === CliCredentialStatus.REVOKED) return;
      await tx.cliCredential.update({
        where: { id: credentialId },
        data: {
          status: CliCredentialStatus.REVOKED,
          revokedAt: new Date(),
        },
      });
    });
  }

  /**
   * Revoke all CLI credentials for an account (used during account disable).
   * Runs inside the caller's transaction.
   */
  async revokeAllForAccountInTransaction(
    tx: import('../../../../generated/prisma/client').Prisma.TransactionClient,
    accountId: string,
  ): Promise<void> {
    await tx.cliCredential.updateMany({
      where: {
        accountId,
        status: CliCredentialStatus.ACTIVE,
      },
      data: {
        status: CliCredentialStatus.REVOKED,
        revokedAt: new Date(),
      },
    });
  }

  /**
   * Authenticate a raw CLI key. Returns the CLI principal or throws.
   * Updates lastUsedAt best-effort (does not block on failure).
   */
  async authenticate(rawKey: string | undefined): Promise<CliAuthContext> {
    if (!rawKey || !rawKey.trim()) {
      throw new DomainError(
        'CLI_CREDENTIAL_INVALID',
        'CLI credential is required.',
        401,
        'X-CLI-Key',
        'Provide a valid CLI credential key in the X-CLI-Key header.',
      );
    }
    const keyHash = hashToken(rawKey);
    const credential = await this.db.cliCredential.findUnique({
      where: { keyHash },
      include: { account: true },
    });
    if (!credential) {
      throw new DomainError(
        'CLI_CREDENTIAL_INVALID',
        'CLI credential is invalid.',
        401,
        'X-CLI-Key',
        'Provide a valid CLI credential key in the X-CLI-Key header.',
      );
    }
    if (credential.status !== CliCredentialStatus.ACTIVE) {
      throw new DomainError(
        'CLI_CREDENTIAL_REVOKED',
        'CLI credential has been revoked.',
        401,
        'X-CLI-Key',
        'Contact an admin to issue a new CLI credential.',
      );
    }
    if (credential.account.status !== 'active') {
      throw new DomainError(
        'CLI_CREDENTIAL_INVALID',
        'Account is not active.',
        401,
        'X-CLI-Key',
        'The account for this CLI credential is not active.',
      );
    }
    // Best-effort lastUsedAt update; do not block on failure.
    this.db.cliCredential
      .update({
        where: { id: credential.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {
        /* best-effort */
      });
    return {
      account: {
        id: credential.account.id,
        username: credential.account.username,
        displayName: credential.account.displayName,
        role: credential.account.role,
        status: credential.account.status,
        canCreateCourse: credential.account.canCreateCourse,
        mustChangePassword: credential.account.mustChangePassword,
      },
      credentialId: credential.id,
      scope: credential.scope,
    };
  }
}

/** Validate a UUID-shaped CLI credential id path parameter. */
export function isCliCredentialId(value: string): boolean {
  return isUuid(value);
}
