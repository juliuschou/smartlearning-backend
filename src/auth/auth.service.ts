import {
  BadRequestException,
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
import { isValidPasswordInput } from './login.dto';

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

    // 找不到帳號時也做一次密碼檢查，避免只看回應快慢就猜出帳號是否存在。
    let passwordMatches = false;
    try {
      const passwordHash =
        account?.passwordHash ?? (await this.getDummyPasswordHash());
      passwordMatches = await argon2.verify(passwordHash, password);
    } catch {
      passwordMatches = false;
    }

    // 登入失敗一律使用同一種回覆，不透露帳號、信箱或角色的狀態。
    if (
      !account ||
      account.status !== user_status_e.ACTIVE ||
      !account.emailVerified ||
      account.roleIds.length === 0 ||
      !account.roleCodes.some((code) =>
        ['SYSTEM_ADMIN', 'TEACHER'].includes(code),
      ) ||
      !passwordMatches
    ) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATION_FAILED',
        message: 'Email or password is incorrect.',
      });
    }

    // 原始登入憑證只交給瀏覽器；資料庫只保存雜湊後的值，避免資料外洩時可直接拿來登入。
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

  async getOwnProfile(userAccountId: string) {
    try {
      const profile = await this.repository.findOwnProfile(userAccountId);
      if (!profile) throw this.unauthorized();
      return profile;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw this.serviceUnavailable();
    }
  }

  async updateOwnProfile(
    userAccountId: string,
    input: { name?: string; phone?: string | null },
  ) {
    if (input.name === undefined && input.phone === undefined) {
      throw new BadRequestException({
        code: 'PROFILE_UPDATE_EMPTY',
        message: 'Provide at least one profile field to update.',
      });
    }
    try {
      const profile = await this.repository.updateOwnProfile(
        userAccountId,
        input,
      );
      if (!profile) throw this.unauthorized();
      return profile;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw this.serviceUnavailable();
    }
  }

  async changeOwnPassword(
    userAccountId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (!isValidPasswordInput(newPassword)) {
      throw new BadRequestException({
        code: 'PASSWORD_POLICY_FAILED',
        message: 'The new password does not meet the password policy.',
      });
    }

    try {
      const currentPasswordHash =
        await this.repository.findPasswordHashForActiveAccount(userAccountId);
      if (!currentPasswordHash) throw this.unauthorized();

      let passwordMatches: boolean;
      try {
        passwordMatches = await argon2.verify(
          currentPasswordHash,
          currentPassword,
        );
      } catch {
        throw this.serviceUnavailable();
      }
      if (!passwordMatches) {
        throw new UnauthorizedException({
          code: 'CURRENT_PASSWORD_INVALID',
          message: 'The current password is incorrect.',
        });
      }

      // 換密碼時同時讓所有已登入的裝置失效，避免舊憑證繼續使用。
      const newPasswordHash = await argon2.hash(newPassword);
      const changed = await this.repository.changePasswordAndRevokeSessions({
        userAccountId,
        currentPasswordHash,
        newPasswordHash,
      });
      if (!changed) {
        throw new UnauthorizedException({
          code: 'CURRENT_PASSWORD_INVALID',
          message: 'The current password is incorrect.',
        });
      }
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadRequestException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }
      throw this.serviceUnavailable();
    }
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

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'A valid login is required.',
    });
  }

  private serviceUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'AUTH_SERVICE_UNAVAILABLE',
      message: 'Authentication service is temporarily unavailable.',
    });
  }
}
