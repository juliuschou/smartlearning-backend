import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { user_status_e } from '../../generated/prisma-app/client';
import { AuthConfig } from './auth.config';
import { AccountForLogin, AuthRepository } from './auth.repository';
import { AuthSecurityService } from './auth-security.service';
import { PermissionSnapshot } from './auth.types';

export interface LoginResult {
  sessionCredential: string;
  csrfToken: string;
}

@Injectable()
export class AuthService {
  private dummyPasswordHash?: Promise<string>;

  constructor(
    private readonly repository: AuthRepository,
    private readonly security: AuthSecurityService,
    private readonly config: AuthConfig,
  ) {}

  createCsrfToken(sessionCredential?: string): string {
    const subject = sessionCredential
      ? this.security.hashSessionCredential(sessionCredential)
      : 'preauth';
    return this.security.createCsrfToken(subject, Date.now());
  }

  async login(email: string, password: string): Promise<LoginResult> {
    this.config.assertSessionDurations();
    const normalizedEmail = email.trim().toLowerCase();

    let account: AccountForLogin | null;
    try {
      account = await this.repository.findAccountForLogin(normalizedEmail);
    } catch {
      throw this.serviceUnavailable();
    }

    let passwordMatches = false;
    try {
      const passwordHash =
        account?.passwordHash ?? (await this.getDummyPasswordHash());
      passwordMatches = await argon2.verify(passwordHash, password);
    } catch {
      passwordMatches = false;
    }

    if (
      !account ||
      account.status !== user_status_e.ACTIVE ||
      !account.emailVerified ||
      account.roleIds.length === 0 ||
      !passwordMatches
    ) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_FAILED',
        message: 'Email or password is incorrect.',
      });
    }

    const sessionCredential = this.security.createSessionCredential();
    const tokenHash = this.security.hashSessionCredential(sessionCredential);
    const permissionSnapshot: PermissionSnapshot = {
      roleIds: account.roleIds,
      roleCodes: account.roleCodes,
      permissionCodes: account.permissionCodes,
    };

    try {
      await this.repository.createSession({
        userAccountId: account.id,
        tokenHash,
        permissionSnapshot,
      });
    } catch {
      throw this.serviceUnavailable();
    }

    return {
      sessionCredential,
      csrfToken: this.security.createCsrfToken(tokenHash),
    };
  }

  async validateSession(sessionCredential: string) {
    this.config.assertSessionDurations();
    const tokenHash = this.security.hashSessionCredential(sessionCredential);
    try {
      return await this.repository.touchValidSession(tokenHash);
    } catch {
      throw this.serviceUnavailable();
    }
  }

  async logout(sessionCredential?: string): Promise<void> {
    if (!sessionCredential) return;
    const tokenHash = this.security.hashSessionCredential(sessionCredential);
    try {
      await this.repository.revokeSession(tokenHash);
    } catch {
      throw this.serviceUnavailable();
    }
  }

  async revokeAllSessionsForAccount(userAccountId: string): Promise<void> {
    try {
      await this.repository.revokeAllSessionsForAccount(userAccountId);
    } catch {
      throw this.serviceUnavailable();
    }
  }

  async revokeSessionsForRole(roleId: string): Promise<void> {
    try {
      await this.repository.revokeSessionsForRole(roleId);
    } catch {
      throw this.serviceUnavailable();
    }
  }

  private getDummyPasswordHash(): Promise<string> {
    this.dummyPasswordHash ??= argon2.hash(
      randomBytes(32).toString('base64url'),
    );
    return this.dummyPasswordHash;
  }

  private serviceUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'AUTH_SERVICE_UNAVAILABLE',
      message: 'Authentication service is temporarily unavailable.',
    });
  }
}
