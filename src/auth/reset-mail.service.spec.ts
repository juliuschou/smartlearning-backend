import nodemailer from 'nodemailer';
import { ResetMailService } from './reset-mail.service';

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn() },
}));

const key = Buffer.alloc(32, 3).toString('base64');

describe('ResetMailService', () => {
  let values: Record<string, string>;
  let service: ResetMailService;

  beforeEach(() => {
    values = {
      EMAIL_OUTBOX_ENABLED: 'true',
      RESET_OUTBOX_ENCRYPTION_KEY: key,
      PASSWORD_RESET_URL: 'https://app.example.test/reset',
      GMAIL_SMTP_USER: 'sender@example.test',
      GMAIL_SMTP_APP_PASSWORD: 'app-password-for-test',
    };
    service = new ResetMailService({
      get: (name: string) => values[name],
    } as never);
    jest.clearAllMocks();
  });

  // 郵件佇列中的收件人與重設網址必須可安全還原，但不能直接看見原文。
  it('encrypts and decrypts the recipient and reset URL', () => {
    const payload = {
      recipient: 'user@example.test',
      resetUrl: 'https://app.example.test/reset?token=opaque',
    };
    const encrypted = service.encryptPayload(payload);

    expect(encrypted.encryptedPayload).not.toContain('opaque');
    expect(service.decryptPayload(encrypted)).toEqual(payload);
  });

  it('rejects tampering with the encrypted payload', () => {
    const encrypted = service.encryptPayload({
      recipient: 'user@example.test',
      resetUrl: 'https://app.example.test/reset?token=opaque',
    });

    expect(() =>
      service.decryptPayload({
        ...encrypted,
        encryptedPayload: `${encrypted.encryptedPayload.slice(0, -2)}AA`,
      }),
    ).toThrow();
  });

  it('fails closed when outbox configuration is incomplete', () => {
    values.RESET_OUTBOX_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
    expect(() => service.assertQueueConfiguration()).toThrow();
  });

  it('rejects unsafe reset URL schemes and credentials', () => {
    values.PASSWORD_RESET_URL = 'javascript:alert(1)';
    expect(() => service.buildResetUrl('token')).toThrow();
    values.PASSWORD_RESET_URL = 'https://user:pass@app.example.test/reset';
    expect(() => service.buildResetUrl('token')).toThrow();
  });

  it('uses Gmail SMTP with TLS and never returns transport credentials', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'message-id' });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

    await service.sendPasswordResetEmail(
      'user@example.test',
      'https://app.example.test/reset?token=opaque',
    );

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        requireTLS: true,
        auth: {
          user: 'sender@example.test',
          pass: 'app-password-for-test',
        },
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.test',
        text: expect.stringContaining(
          'https://app.example.test/reset?token=opaque',
        ),
      }),
    );
  });
});
