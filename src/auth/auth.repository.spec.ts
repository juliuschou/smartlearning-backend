import { PrismaService } from '../database/prisma.service';
import { AuthRepository } from './auth.repository';

describe('AuthRepository session validity query', () => {
  // 改密碼與作廢既有登入狀態必須綁在同一個不可拆開的動作中。
  it('updates the password and revokes every active session in one transaction', async () => {
    const executeRaw = jest
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);
    const transaction = { $executeRaw: executeRaw };
    const client = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const repository = new AuthRepository({
      client,
    } as unknown as PrismaService);

    await expect(
      repository.changePasswordAndRevokeSessions({
        userAccountId: 'account-id',
        currentPasswordHash: 'old-hash',
        newPasswordHash: 'new-hash',
      }),
    ).resolves.toBe(true);

    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(2);
    const passwordUpdate = executeRaw.mock.calls[0][0] as {
      sql?: string;
      text?: string;
      values?: unknown[];
    };
    const revokeUpdate = executeRaw.mock.calls[1][0] as {
      sql?: string;
      text?: string;
      values?: unknown[];
    };
    expect(
      `${passwordUpdate.sql ?? ''} ${passwordUpdate.text ?? ''}`,
    ).toContain('UPDATE app.user_account');
    expect(passwordUpdate.values).toEqual(
      expect.arrayContaining(['new-hash', 'account-id', 'old-hash']),
    );
    expect(`${revokeUpdate.sql ?? ''} ${revokeUpdate.text ?? ''}`).toContain(
      'UPDATE app.login_session',
    );
    expect(revokeUpdate.values).toContain('account-id');
  });

  it('does not revoke sessions if the current password hash changed concurrently', async () => {
    const executeRaw = jest.fn().mockResolvedValueOnce(0);
    const transaction = { $executeRaw: executeRaw };
    const client = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const repository = new AuthRepository({
      client,
    } as unknown as PrismaService);

    await expect(
      repository.changePasswordAndRevokeSessions({
        userAccountId: 'account-id',
        currentPasswordHash: 'old-hash',
        newPasswordHash: 'new-hash',
      }),
    ).resolves.toBe(false);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('uses atomic expiry, account, role-status and monotonic last-used conditions', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const client = {
      $queryRaw: queryRaw as unknown as PrismaService['client']['$queryRaw'],
    };
    const repository = new AuthRepository({
      client,
    } as unknown as PrismaService);

    await expect(
      repository.touchValidSession('hashed-token'),
    ).resolves.toBeNull();

    const query = queryRaw.mock.calls[0][0] as {
      sql?: string;
      text?: string;
      values?: unknown[];
    };
    const sql = `${query.sql ?? ''}\n${query.text ?? ''}`;

    expect(sql).toContain('UPDATE app.login_session');
    expect(sql).toContain('GREATEST(session.last_used_at, clock.now)');
    expect(sql).toContain(
      "session.created_at <= clock.now - INTERVAL '24 hours'",
    );
    expect(sql).toContain(
      "session.last_used_at <= clock.now - INTERVAL '30 minutes'",
    );
    expect(sql).toContain("account.status <> 'ACTIVE'::app.user_status_e");
    expect(sql).toContain(
      "assigned_role.status <> 'ENABLED'::app.role_status_e",
    );
    expect(query.values).toContain('hashed-token');
  });
});
