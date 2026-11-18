import { PrismaService } from '../database/prisma.service';
import { PasswordResetRepository } from './password-reset.repository';

describe('PasswordResetRepository', () => {
  // 建立重設流程時，同時保護帳號、只存不可還原的值，並把郵件內容加密排入待寄清單。
  it('locks eligible accounts and atomically queues a hashed reset link and encrypted mail', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'account-id', email: 'user@example.test' }])
      .mockResolvedValueOnce([{ found: false }])
      .mockResolvedValueOnce([{ found: false }])
      .mockResolvedValueOnce([{ id: 'link-id' }]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const transaction = { $queryRaw: queryRaw, $executeRaw: executeRaw };
    const client = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const repository = new PasswordResetRepository({
      client,
    } as unknown as PrismaService);

    await expect(
      repository.queuePasswordReset({
        email: 'user@example.test',
        tokenHash: 'sha256-only-hash',
        mailPayload: {
          encryptedPayload: 'ciphertext',
          encryptionNonce: 'nonce',
          encryptionTag: 'tag',
        },
      }),
    ).resolves.toBe('QUEUED');

    expect(client.$transaction).toHaveBeenCalledTimes(1);
    const accountLookup = queryRaw.mock.calls[0][0] as {
      sql?: string;
      text?: string;
    };
    expect(`${accountLookup.sql ?? ''} ${accountLookup.text ?? ''}`).toContain(
      'FOR UPDATE OF account',
    );
    const activeCheck = queryRaw.mock.calls[2][0] as {
      sql?: string;
      text?: string;
    };
    const activeSql = `${activeCheck.sql ?? ''} ${activeCheck.text ?? ''}`;
    expect(activeSql).toContain('outbox.locked_until > statement_timestamp()');
    const linkInsert = queryRaw.mock.calls[3][0] as {
      sql?: string;
      text?: string;
      values?: unknown[];
    };
    expect(`${linkInsert.sql ?? ''} ${linkInsert.text ?? ''}`).toContain(
      "'PASSWORD_RESET'::app.one_time_link_kind_e",
    );
    expect(linkInsert.values).toContain('sha256-only-hash');
    const outboxInsert = executeRaw.mock.calls.at(-1)?.[0] as {
      sql?: string;
      text?: string;
      values?: unknown[];
    };
    expect(`${outboxInsert.sql ?? ''} ${outboxInsert.text ?? ''}`).toContain(
      'INSERT INTO app.email_outbox',
    );
    expect(outboxInsert.values).toEqual(
      expect.arrayContaining(['ciphertext', 'nonce', 'tag']),
    );
  });

  it('does not create a reset link when the account cooldown is active', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'account-id', email: 'user@example.test' }])
      .mockResolvedValueOnce([{ found: true }]);
    const executeRaw = jest.fn();
    const transaction = { $queryRaw: queryRaw, $executeRaw: executeRaw };
    const client = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const repository = new PasswordResetRepository({
      client,
    } as unknown as PrismaService);

    await expect(
      repository.queuePasswordReset({
        email: 'user@example.test',
        tokenHash: 'hash',
        mailPayload: {
          encryptedPayload: 'ciphertext',
          encryptionNonce: 'nonce',
          encryptionTag: 'tag',
        },
      }),
    ).resolves.toBe('COOLDOWN');
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('consumes a reset link and revokes sessions in one transaction', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValue([{ user_account_id: 'account-id' }]);
    const executeRaw = jest.fn().mockResolvedValue(2);
    const transaction = { $queryRaw: queryRaw, $executeRaw: executeRaw };
    const client = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const repository = new PasswordResetRepository({
      client,
    } as unknown as PrismaService);

    await expect(
      repository.consumePasswordReset({
        tokenHash: 'token-hash',
        newPasswordHash: 'argon-hash',
      }),
    ).resolves.toBe(true);

    const consume = queryRaw.mock.calls[0][0] as {
      sql?: string;
      text?: string;
      values?: unknown[];
    };
    const sql = `${consume.sql ?? ''} ${consume.text ?? ''}`;
    expect(sql).toContain('FOR UPDATE OF link, account');
    expect(sql).toContain('link.expires_at > statement_timestamp()');
    expect(sql).toContain('UPDATE app.one_time_link');
    expect(consume.values).toEqual(
      expect.arrayContaining(['token-hash', 'argon-hash']),
    );
    const revoke = executeRaw.mock.calls[0][0] as {
      sql?: string;
      text?: string;
      values?: unknown[];
    };
    expect(`${revoke.sql ?? ''} ${revoke.text ?? ''}`).toContain(
      'UPDATE app.login_session',
    );
    expect(revoke.values).toContain('account-id');
  });

  it('claims outbox jobs with a distinct lease fence for each attempt', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const client = {
      $queryRaw: queryRaw as unknown as PrismaService['client']['$queryRaw'],
    };
    const repository = new PasswordResetRepository({
      client,
    } as unknown as PrismaService);

    await repository.claimOutboxBatch(10);

    const claim = queryRaw.mock.calls[0][0] as {
      sql?: string;
      text?: string;
    };
    const sql = `${claim.sql ?? ''} ${claim.text ?? ''}`;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('claim_token = gen_random_uuid()');
    expect(sql).toContain('locked_until <= statement_timestamp()');
  });

  it('does not expire a link when a stale worker no longer owns the lease', async () => {
    const executeRaw = jest.fn().mockResolvedValue(0);
    const transaction = { $executeRaw: executeRaw };
    const client = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const repository = new PasswordResetRepository({
      client,
    } as unknown as PrismaService);

    await repository.markOutboxFailed({
      id: 'outbox-id',
      relatedId: 'link-id',
      claimToken: 'stale-claim-id',
      attempts: 5,
      errorCode: 'SMTP_DELIVERY_FAILED',
    });

    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('rejects replay when conditional token consumption returns no account', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const executeRaw = jest.fn();
    const transaction = { $queryRaw: queryRaw, $executeRaw: executeRaw };
    const client = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const repository = new PasswordResetRepository({
      client,
    } as unknown as PrismaService);

    await expect(
      repository.consumePasswordReset({
        tokenHash: 'already-used-hash',
        newPasswordHash: 'argon-hash',
      }),
    ).resolves.toBe(false);
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
