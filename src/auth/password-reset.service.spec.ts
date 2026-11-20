import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { PasswordResetRepository } from './password-reset.repository';
import { PasswordResetService } from './password-reset.service';
import { AuthSecurityService } from './auth-security.service';
import { ResetMailService } from './reset-mail.service';

jest.mock('argon2', () => ({
  hash: jest.fn().mockResolvedValue('new-argon2-hash'),
}));

const encryptionKey = Buffer.alloc(32, 7).toString('base64');

describe('PasswordResetService', () => {
  const repository = {
    queuePasswordReset: jest.fn(),
    consumePasswordReset: jest.fn(),
  };
  const security = {
    createOneTimeCredential: jest.fn(),
    hashOneTimeCredential: jest.fn(),
  };
  const config = {
    get: (key: string) =>
      ({
        EMAIL_OUTBOX_ENABLED: 'true',
        RESET_OUTBOX_ENCRYPTION_KEY: encryptionKey,
        PASSWORD_RESET_URL: 'https://app.example.test/reset-password',
      })[key],
  };
  const mail = new ResetMailService(config as never);
  const service = new PasswordResetService(
    repository as unknown as PasswordResetRepository,
    security as unknown as AuthSecurityService,
    mail,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    security.createOneTimeCredential.mockReturnValue('z'.repeat(43));
    security.hashOneTimeCredential.mockImplementation(
      (token: string) => `sha256:${token.length}`,
    );
    repository.queuePasswordReset.mockResolvedValue('QUEUED');
    repository.consumePasswordReset.mockResolvedValue(true);
    (argon2.hash as jest.Mock).mockResolvedValue('new-argon2-hash');
  });

  // 不論帳號是否符合條件，對外都回覆相同結果，避免被用來猜測帳號存在。
  it('returns the same generic response for queued and ineligible account requests', async () => {
    repository.queuePasswordReset
      .mockResolvedValueOnce('QUEUED')
      .mockResolvedValueOnce('NOT_ELIGIBLE');

    const known = await service.requestPasswordReset(' User@Example.test ');
    const unknown = await service.requestPasswordReset('missing@example.test');

    expect(known).toEqual(unknown);
    expect(known).toEqual({
      message:
        'If the account is eligible, password reset instructions will be sent.',
    });
    expect(repository.queuePasswordReset).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ email: 'user@example.test' }),
    );
  });

  it('stores only a token hash and an encrypted reset URL in the queue request', async () => {
    await service.requestPasswordReset('user@example.test');

    const request = repository.queuePasswordReset.mock.calls[0][0] as {
      tokenHash: string;
      mailPayload: {
        encryptedPayload: string;
        encryptionNonce: string;
        encryptionTag: string;
      };
    };
    expect(request.tokenHash).toBe('sha256:43');
    expect(JSON.stringify(request)).not.toContain('z'.repeat(43));
    expect(mail.decryptPayload(request.mailPayload)).toEqual({
      recipient: 'user@example.test',
      resetUrl: `https://app.example.test/reset-password#token=${'z'.repeat(43)}`,
    });
  });

  it('returns a retryable service error when the queue cannot persist the request', async () => {
    repository.queuePasswordReset.mockRejectedValue(
      new Error('database failure'),
    );

    await expect(
      service.requestPasswordReset('user@example.test'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('hashes the new password and asks the repository to consume the token atomically', async () => {
    await service.resetPassword('t'.repeat(43), 'new-password');

    expect(argon2.hash).toHaveBeenCalledWith('new-password');
    expect(repository.consumePasswordReset).toHaveBeenCalledWith({
      tokenHash: 'sha256:43',
      newPasswordHash: 'new-argon2-hash',
    });
  });

  it('rejects invalid, short, or expired-format tokens without changing data', async () => {
    await expect(
      service.resetPassword('bad-token', 'new-password'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.resetPassword('t'.repeat(43), 'short'),
    ).rejects.toMatchObject({ response: { code: 'PASSWORD_POLICY_FAILED' } });
    expect(repository.consumePasswordReset).not.toHaveBeenCalled();
  });

  it('returns a generic failure when the token has already been consumed', async () => {
    repository.consumePasswordReset.mockResolvedValue(false);

    await expect(
      service.resetPassword('t'.repeat(43), 'new-password'),
    ).rejects.toMatchObject({
      response: { code: 'PASSWORD_RESET_INVALID' },
    });
  });
});
