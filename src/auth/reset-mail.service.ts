import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';

export interface PasswordResetMailPayload {
  recipient: string;
  resetUrl: string;
}

export interface TeacherInvitationMailPayload {
  recipient: string;
  invitationUrl: string;
}

export type EncryptedMailKind = 'PASSWORD_RESET' | 'TEACHER_INVITATION';

const KIND_KEY: Record<EncryptedMailKind, string> = {
  PASSWORD_RESET: 'resetUrl',
  TEACHER_INVITATION: 'invitationUrl',
};

export interface EncryptedMailPayload {
  encryptedPayload: string;
  encryptionNonce: string;
  encryptionTag: string;
}

@Injectable()
export class ResetMailService {
  constructor(private readonly config: ConfigService) {}

  isOutboxEnabled(): boolean {
    return this.config.get<string>('EMAIL_OUTBOX_ENABLED') === 'true';
  }

  assertQueueConfiguration(): void {
    if (!this.isOutboxEnabled()) {
      throw new ServiceUnavailableException({
        code: 'AUTH_SERVICE_UNAVAILABLE',
        message: 'Authentication service is temporarily unavailable.',
      });
    }
    this.encryptionKey();
    this.resetUrl('validation-token');
  }

  encryptPayload(
    payload: PasswordResetMailPayload | TeacherInvitationMailPayload,
  ): EncryptedMailPayload {
    // 信件內容會暫存在資料庫等待寄送，因此先加密，避免收件地址與一次性連結被直接讀出。
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), nonce);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    return {
      encryptedPayload: encrypted.toString('base64'),
      encryptionNonce: nonce.toString('base64'),
      encryptionTag: cipher.getAuthTag().toString('base64'),
    };
  }

  decryptPayload(
    payload: EncryptedMailPayload,
    kind: EncryptedMailKind = 'PASSWORD_RESET',
  ): PasswordResetMailPayload | TeacherInvitationMailPayload {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey(),
      Buffer.from(payload.encryptionNonce, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(payload.encryptionTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.encryptedPayload, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const value: unknown = JSON.parse(plaintext);
    const linkKey = KIND_KEY[kind];
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as Record<string, unknown>).recipient !== 'string' ||
      typeof (value as Record<string, unknown>)[linkKey] !== 'string'
    ) {
      throw new Error('Invalid encrypted mail payload.');
    }
    return value as PasswordResetMailPayload | TeacherInvitationMailPayload;
  }

  buildResetUrl(token: string): string {
    return this.resetUrl(token);
  }

  async sendPasswordResetEmail(
    recipient: string,
    resetUrl: string,
  ): Promise<void> {
    const transporter = this.createTransporter();
    await transporter.sendMail({
      from: this.config.get<string>('GMAIL_FROM')?.trim() || this.smtpUser(),
      to: recipient,
      subject: 'Reset your SmartLearning password',
      text: `Use this one-time link within 30 minutes to reset your password:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
    });
  }

  private createTransporter(): Transporter {
    const user = this.smtpUser();
    const password = this.config.get<string>('GMAIL_SMTP_APP_PASSWORD')?.trim();
    if (!password)
      throw new Error('GMAIL_SMTP_APP_PASSWORD is not configured.');
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user, pass: password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  private smtpUser(): string {
    const user = this.config.get<string>('GMAIL_SMTP_USER')?.trim();
    if (!user) throw new Error('GMAIL_SMTP_USER is not configured.');
    return user;
  }

  private resetUrl(token: string): string {
    const configured = this.config.get<string>('PASSWORD_RESET_URL')?.trim();
    if (!configured) {
      throw new ServiceUnavailableException({
        code: 'AUTH_SERVICE_UNAVAILABLE',
        message: 'Authentication service is temporarily unavailable.',
      });
    }
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new ServiceUnavailableException({
        code: 'AUTH_SERVICE_UNAVAILABLE',
        message: 'Authentication service is temporarily unavailable.',
      });
    }
    // 只接受乾淨的網頁連結；一次性 bearer token 放在 fragment，避免進入 HTTP request URL、伺服器日誌或 referrer。
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new ServiceUnavailableException({
        code: 'AUTH_SERVICE_UNAVAILABLE',
        message: 'Authentication service is temporarily unavailable.',
      });
    }
    url.hash = new URLSearchParams({ token }).toString();
    return url.toString();
  }

  private encryptionKey(): Buffer {
    const value = this.config
      .get<string>('RESET_OUTBOX_ENCRYPTION_KEY')
      ?.trim();
    if (!value) {
      throw new ServiceUnavailableException({
        code: 'AUTH_SERVICE_UNAVAILABLE',
        message: 'Authentication service is temporarily unavailable.',
      });
    }
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value) {
      throw new ServiceUnavailableException({
        code: 'AUTH_SERVICE_UNAVAILABLE',
        message: 'Authentication service is temporarily unavailable.',
      });
    }
    return key;
  }
}
