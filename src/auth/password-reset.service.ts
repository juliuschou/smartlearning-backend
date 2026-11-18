import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { isValidPasswordInput } from './login.dto';
import { AuthSecurityService } from './auth-security.service';
import { PasswordResetRepository } from './password-reset.repository';
import { ResetMailService } from './reset-mail.service';

export const PASSWORD_RESET_ACCEPTED_MESSAGE =
  'If the account is eligible, password reset instructions will be sent.';

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly repository: PasswordResetRepository,
    private readonly security: AuthSecurityService,
    private readonly mail: ResetMailService,
  ) {}

  async requestPasswordReset(email: string): Promise<{ message: string }> {
    // 不論帳號是否存在或符合資格，都回相同訊息，避免讓人逐一猜測有效帳號。
    this.mail.assertQueueConfiguration();
    const normalizedEmail = email.trim().toLowerCase();
    const token = this.security.createOneTimeCredential();
    const mailPayload = this.mail.encryptPayload({
      recipient: normalizedEmail,
      resetUrl: this.mail.buildResetUrl(token),
    });
    try {
      await this.repository.queuePasswordReset({
        email: normalizedEmail,
        tokenHash: this.security.hashOneTimeCredential(token),
        mailPayload,
      });
    } catch {
      this.logger.error('Password reset request could not be queued.');
      throw this.serviceUnavailable();
    }
    return { message: PASSWORD_RESET_ACCEPTED_MESSAGE };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (!isValidPasswordInput(newPassword)) {
      throw new BadRequestException({
        code: 'PASSWORD_POLICY_FAILED',
        message: 'The new password does not meet the password policy.',
      });
    }
    // 先拒絕格式不符的連結；資料庫只保存無法直接拿來重設密碼的摘要，不保存原始的一次性代碼。
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
      throw this.invalidResetToken();
    }

    try {
      const newPasswordHash = await argon2.hash(newPassword);
      const updated = await this.repository.consumePasswordReset({
        tokenHash: this.security.hashOneTimeCredential(token),
        newPasswordHash,
      });
      if (!updated) throw this.invalidResetToken();
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }
      throw this.serviceUnavailable();
    }
  }

  private invalidResetToken(): BadRequestException {
    return new BadRequestException({
      code: 'PASSWORD_RESET_INVALID',
      message: 'The password reset link is invalid or expired.',
    });
  }

  private serviceUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'AUTH_SERVICE_UNAVAILABLE',
      message: 'Authentication service is temporarily unavailable.',
    });
  }
}
