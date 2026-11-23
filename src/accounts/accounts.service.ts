import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma-app/client';
import { AuthSecurityService } from '../auth/auth-security.service';
import { ResetMailService } from '../auth/reset-mail.service';
import { AccountsRepository } from './accounts.repository';
import { CreateTeacherDto } from './create-teacher.dto';

export const TEACHER_CREATE_PERMISSION = 'M03_WRITE';
export const INVITATION_VALIDITY_DAYS = 7;

export interface CreatedTeacher {
  accountId: string;
  status: 'INVITED';
  name: string;
  accountName: string;
  email: string;
  roles: ['TEACHER'];
  inviteExpiresAt: string;
}

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);
  private dummyPasswordHash?: Promise<string>;

  constructor(
    private readonly repository: AccountsRepository,
    private readonly security: AuthSecurityService,
    private readonly mail: ResetMailService,
    private readonly config: ConfigService,
  ) {}

  async createTeacher(
    input: CreateTeacherDto,
    permissionCodes: string[],
    assignedBy: string,
  ): Promise<CreatedTeacher> {
    if (!permissionCodes.includes(TEACHER_CREATE_PERMISSION)) {
      throw new ForbiddenException({
        code: 'M03_PERMISSION_REQUIRED',
        message:
          'You are not allowed to perform this account-management operation.',
      });
    }
    this.mail.assertQueueConfiguration();

    const normalizedEmail = input.email.trim().toLowerCase();
    const passwordHash = await this.getDummyPasswordHash();
    const invitationToken = this.security.createOneTimeCredential();
    const expiresAt = new Date(
      Date.now() + INVITATION_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    );
    const mailPayload = this.mail.encryptPayload({
      recipient: normalizedEmail,
      invitationUrl: this.buildInvitationUrl(invitationToken),
    });

    try {
      const account = await this.repository.createTeacher({
        email: normalizedEmail,
        name: input.name.trim(),
        accountName: input.accountName,
        phone: input.phone ?? null,
        passwordHash,
        assignedBy,
        invitationTokenHash:
          this.security.hashOneTimeCredential(invitationToken),
        invitationExpiresAt: expiresAt,
        mailPayload,
      });
      return {
        accountId: account.accountId,
        status: 'INVITED',
        name: account.name,
        accountName: account.accountName,
        email: account.email,
        roles: ['TEACHER'],
        inviteExpiresAt: account.inviteExpiresAt.toISOString(),
      };
    } catch (error) {
      // Raw SQL 經 driver adapter 的資料庫錯誤以 P2010 標記，真正的 Postgres
      // 錯誤碼與被違反的約束名稱在 meta.driverAdapterError.cause 中。
      const conflict = uniqueViolationConstraint(error);
      if (
        conflict === 'uq_user_email_lower' ||
        conflict === 'user_account_email_key'
      ) {
        throw new ConflictException({
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'An account with this email already exists.',
        });
      }
      if (
        conflict === 'uq_user_account_name' ||
        conflict === 'user_account_account_name_key'
      ) {
        throw new ConflictException({
          code: 'ACCOUNT_NAME_ALREADY_EXISTS',
          message: 'An account with this account name already exists.',
        });
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new ServiceUnavailableException({
          code: 'SERVICE_TEMPORARILY_UNAVAILABLE',
          message: 'The account could not be created right now. Retry.',
        });
      }
      this.logger.error('Teacher account creation failed.');
      throw this.serviceUnavailable();
    }
  }

  private buildInvitationUrl(token: string): string {
    const configured = this.config.get('TEACHER_INVITATION_URL')?.trim();
    if (!configured) throw this.serviceUnavailable();
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw this.serviceUnavailable();
    }
    // 一次性 token 放 fragment，不進 HTTP request URL、伺服器日誌或 referrer（比照密碼重設）。
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw this.serviceUnavailable();
    }
    url.hash = new URLSearchParams({ token }).toString();
    return url.toString();
  }

  private getDummyPasswordHash(): Promise<string> {
    // INVITED 帳號尚無密碼；欄位為 NOT NULL，先存無法對應任何已知密碼的雜湊。
    this.dummyPasswordHash ??= argon2.hash(
      randomBytes(32).toString('base64url'),
    );
    return this.dummyPasswordHash;
  }

  private serviceUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'SERVICE_TEMPORARILY_UNAVAILABLE',
      message: 'The account service is temporarily unavailable.',
    });
  }
}

// 從 P2010 driver-adapter 錯誤中取出被違反的 Postgres 約束名稱；非唯一性衝突回 undefined。
function uniqueViolationConstraint(error: unknown): string | undefined {
  if (!(
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2010'
  )) {
    return undefined;
  }
  const cause = (
    error.meta as
      | {
          driverAdapterError?: {
            cause?: { originalCode?: string; originalMessage?: string };
          };
        }
      | undefined
  )?.driverAdapterError?.cause;
  if (cause?.originalCode !== '23505') return undefined;
  const match = /constraint "([^"]+)"/.exec(cause.originalMessage ?? '');
  return match?.[1];
}
