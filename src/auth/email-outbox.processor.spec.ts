import { EmailOutboxProcessor } from './email-outbox.processor';
import { PasswordResetRepository } from './password-reset.repository';
import { ResetMailService } from './reset-mail.service';

describe('EmailOutboxProcessor', () => {
  const repository = {
    claimOutboxBatch: jest.fn(),
    isPasswordResetLinkPending: jest.fn(),
    markOutboxCancelled: jest.fn(),
    markOutboxSent: jest.fn(),
    markOutboxFailed: jest.fn(),
  };
  const mail = {
    isOutboxEnabled: jest.fn(),
    decryptPayload: jest.fn(),
    sendPasswordResetEmail: jest.fn(),
  };
  const processor = new EmailOutboxProcessor(
    repository as unknown as PasswordResetRepository,
    mail as unknown as ResetMailService,
  );
  const job = {
    id: 'outbox-id',
    relatedId: 'link-id',
    encryptedPayload: 'ciphertext',
    encryptionNonce: 'nonce',
    encryptionTag: 'tag',
    claimToken: 'claim-token-id',
    attempts: 1,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mail.isOutboxEnabled.mockReturnValue(true);
    repository.claimOutboxBatch.mockResolvedValue([job]);
    repository.isPasswordResetLinkPending.mockResolvedValue(true);
    mail.decryptPayload.mockReturnValue({
      recipient: 'user@example.test',
      resetUrl: 'https://app.example.test/reset#token=secret-token',
    });
    mail.sendPasswordResetEmail.mockResolvedValue(undefined);
    repository.markOutboxSent.mockResolvedValue(undefined);
    repository.markOutboxFailed.mockResolvedValue(undefined);
  });

  // 只寄出仍有效的重設連結；成功、取消與失敗都要留下可追蹤的處理結果。
  it('sends only a pending link and records delivery', async () => {
    await processor.drain();

    expect(repository.claimOutboxBatch).toHaveBeenCalledWith(10);
    expect(mail.sendPasswordResetEmail).toHaveBeenCalledWith(
      'user@example.test',
      'https://app.example.test/reset#token=secret-token',
    );
    expect(repository.markOutboxSent).toHaveBeenCalledWith({
      id: 'outbox-id',
      relatedId: 'link-id',
      claimToken: 'claim-token-id',
    });
    expect(repository.markOutboxFailed).not.toHaveBeenCalled();
  });

  it('does not deliver cancelled/expired links', async () => {
    repository.isPasswordResetLinkPending.mockResolvedValue(false);

    await processor.drain();

    expect(repository.markOutboxCancelled).toHaveBeenCalledWith({
      id: 'outbox-id',
      claimToken: 'claim-token-id',
    });
    expect(mail.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('schedules a retry without logging delivery secrets', async () => {
    mail.sendPasswordResetEmail.mockRejectedValue(
      new Error('sensitive details'),
    );

    await processor.drain();

    expect(repository.markOutboxFailed).toHaveBeenCalledWith({
      id: 'outbox-id',
      relatedId: 'link-id',
      claimToken: 'claim-token-id',
      attempts: 1,
      errorCode: 'SMTP_DELIVERY_FAILED',
    });
  });
});
