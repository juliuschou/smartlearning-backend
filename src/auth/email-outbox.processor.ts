import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PasswordResetRepository } from './password-reset.repository';
import { ResetMailService } from './reset-mail.service';

@Injectable()
export class EmailOutboxProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailOutboxProcessor.name);
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private readonly repository: PasswordResetRepository,
    private readonly mail: ResetMailService,
  ) {}

  onModuleInit(): void {
    if (!this.mail.isOutboxEnabled()) return;
    this.timer = setInterval(() => void this.drain(), 5000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async drain(): Promise<void> {
    if (this.draining || !this.mail.isOutboxEnabled()) return;
    this.draining = true;
    try {
      const batch = await this.repository.claimOutboxBatch(10);
      await Promise.all(batch.map((job) => this.deliver(job)));
    } catch {
      this.logger.error('Email outbox poll failed.');
    } finally {
      this.draining = false;
    }
  }

  private async deliver(job: {
    id: string;
    relatedId: string;
    encryptedPayload: string;
    encryptionNonce: string;
    encryptionTag: string;
    claimToken: string;
    attempts: number;
  }): Promise<void> {
    try {
      // 寄出前再確認連結還有效，避免已取消或已過期的信件仍送到收件者手上。
      const isPending = await this.repository.isPasswordResetLinkPending(
        job.relatedId,
      );
      if (!isPending) {
        await this.repository.markOutboxCancelled({
          id: job.id,
          claimToken: job.claimToken,
        });
        return;
      }
      const payload = this.mail.decryptPayload(job, 'PASSWORD_RESET');
      if (!('resetUrl' in payload)) {
        throw new Error('Invalid encrypted mail payload.');
      }
      await this.mail.sendPasswordResetEmail(
        payload.recipient,
        payload.resetUrl,
      );
      await this.repository.markOutboxSent({
        id: job.id,
        relatedId: job.relatedId,
        claimToken: job.claimToken,
      });
    } catch (error) {
      const errorCode = safeErrorCode(error);
      try {
        await this.repository.markOutboxFailed({
          id: job.id,
          relatedId: job.relatedId,
          claimToken: job.claimToken,
          attempts: job.attempts,
          errorCode,
        });
        if (job.attempts >= 5) {
          this.logger.error('Email outbox job permanently failed.');
        } else {
          this.logger.warn('Email outbox delivery failed; retry scheduled.');
        }
      } catch {
        this.logger.error('Email outbox state update failed.');
      }
    }
  }
}

function safeErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,80}$/.test(error.code)
  ) {
    return error.code;
  }
  return 'SMTP_DELIVERY_FAILED';
}
