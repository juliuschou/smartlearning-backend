import { PrismaService } from '../database/prisma.service';
import { AuthRepository } from './auth.repository';

describe('AuthRepository session validity query', () => {
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
