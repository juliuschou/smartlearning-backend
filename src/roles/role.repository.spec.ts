import { ConflictException } from '@nestjs/common';
import { Prisma, role_status_e } from '../../generated/prisma-app/client';
import { AuthRepository } from '../auth/auth.repository';
import { PrismaService } from '../database/prisma.service';
import { RoleRepository } from './role.repository';

function makeHarness() {
  const transaction = {
    role: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'role-id',
        status: role_status_e.ENABLED,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: jest.fn(),
  };
  const client = {
    $transaction: jest.fn(
      async (callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
    ),
  };
  const authRepository = {
    revokeSessionsForRoleInTransaction: jest.fn(),
  };
  const repository = new RoleRepository(
    { client } as unknown as PrismaService,
    authRepository as unknown as AuthRepository,
  );
  return { repository, transaction, client, authRepository };
}

describe('RoleRepository.setStatus', () => {
  it('rejects disabling a role that would leave an active account without a valid role', async () => {
    const { repository, transaction, authRepository } = makeHarness();
    transaction.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'affected-account' }]);

    await expect(
      repository.setStatus('TEACHER', 'DISABLED'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.role.updateMany).not.toHaveBeenCalled();
    expect(
      authRepository.revokeSessionsForRoleInTransaction,
    ).not.toHaveBeenCalled();
  });

  it('rejects disabling SYSTEM_ADMIN when no other effective administrator remains', async () => {
    const { repository, transaction, authRepository } = makeHarness();
    transaction.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }]);

    await expect(
      repository.setStatus('SYSTEM_ADMIN', 'DISABLED'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.role.updateMany).not.toHaveBeenCalled();
    expect(
      authRepository.revokeSessionsForRoleInTransaction,
    ).not.toHaveBeenCalled();
  });

  it('disables the role and revokes affected sessions within a serializable transaction', async () => {
    const { repository, transaction, client, authRepository } = makeHarness();
    transaction.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 2n }]);

    await repository.setStatus('SYSTEM_ADMIN', 'DISABLED');

    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(transaction.role.updateMany).toHaveBeenCalledWith({
      where: { id: 'role-id', status: role_status_e.ENABLED },
      data: { status: role_status_e.DISABLED, updated_at: expect.any(Date) },
    });
    expect(
      authRepository.revokeSessionsForRoleInTransaction,
    ).toHaveBeenCalledWith(transaction, 'role-id');
  });

  it('retries session revocation for an already-disabled role without mutating role state', async () => {
    const { repository, transaction, authRepository } = makeHarness();
    transaction.role.findUnique.mockResolvedValue({
      id: 'role-id',
      status: role_status_e.DISABLED,
    });

    await repository.setStatus('TEACHER', 'DISABLED');

    expect(transaction.role.updateMany).not.toHaveBeenCalled();
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(
      authRepository.revokeSessionsForRoleInTransaction,
    ).toHaveBeenCalledWith(transaction, 'role-id');
  });

  it('does not revoke sessions when re-enabling a role', async () => {
    const { repository, transaction, authRepository } = makeHarness();
    transaction.role.findUnique.mockResolvedValue({
      id: 'role-id',
      status: role_status_e.DISABLED,
    });

    await repository.setStatus('TEACHER', 'ENABLED');

    expect(transaction.role.updateMany).toHaveBeenCalledWith({
      where: { id: 'role-id', status: role_status_e.DISABLED },
      data: { status: role_status_e.ENABLED, updated_at: expect.any(Date) },
    });
    expect(
      authRepository.revokeSessionsForRoleInTransaction,
    ).not.toHaveBeenCalled();
  });
});
