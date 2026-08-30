import { hashToken } from '../../../common/crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import { CliCredentialService } from './cli-credential.service';

const ACCOUNT_ID = '01900000-0000-7000-8000-000000000001';
const CREDENTIAL_ID = '01900000-0000-7000-8000-000000000002';
const SUCCESSOR_ID = '01900000-0000-7000-8000-000000000003';

function predecessor(overrides: Record<string, unknown> = {}) {
  return {
    id: CREDENTIAL_ID,
    accountId: ACCOUNT_ID,
    name: 'automation',
    keyHash: 'predecessor-hash',
    scope: 'all_courses',
    status: 'active',
    lastUsedAt: null,
    createdAt: new Date('2026-08-30T00:00:00.000Z'),
    revokedAt: null,
    rotatedFromId: null,
    rotatedTo: null,
    ...overrides,
  };
}

function successor(overrides: Record<string, unknown> = {}) {
  return {
    id: SUCCESSOR_ID,
    accountId: ACCOUNT_ID,
    name: 'automation',
    keyHash: 'successor-hash',
    scope: 'all_courses',
    status: 'active',
    lastUsedAt: null,
    createdAt: new Date('2026-08-30T00:00:01.000Z'),
    revokedAt: null,
    rotatedFromId: CREDENTIAL_ID,
    ...overrides,
  };
}

describe('CliCredentialService.rotateCredential', () => {
  const tx = {
    account: { findUnique: jest.fn() },
    cliCredential: {
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
  };
  const run = jest.fn(async (work: (client: unknown) => Promise<unknown>) =>
    work(tx),
  );
  const lockAccountForUpdate = jest.fn().mockResolvedValue(undefined);
  let service: CliCredentialService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CliCredentialService(
      {} as PrismaService,
      { run, lockAccountForUpdate } as unknown as TransactionService,
    );
    tx.account.findUnique.mockResolvedValue({
      id: ACCOUNT_ID,
      status: 'active',
    });
    tx.cliCredential.findUnique.mockResolvedValue(predecessor());
    tx.cliCredential.update.mockResolvedValue(
      predecessor({
        name: 'automation~rotated~' + CREDENTIAL_ID,
        status: 'revoked',
        revokedAt: new Date(),
      }),
    );
    tx.cliCredential.create.mockImplementation(async ({ data }) =>
      successor({ ...data }),
    );
  });

  it('locks the account and atomically replaces the active predecessor', async () => {
    const result = await service.rotateCredential(ACCOUNT_ID, CREDENTIAL_ID);
    const updateData = tx.cliCredential.update.mock.calls[0][0].data;
    const createData = tx.cliCredential.create.mock.calls[0][0].data;

    expect(run).toHaveBeenCalledTimes(1);
    expect(lockAccountForUpdate).toHaveBeenCalledWith(tx, ACCOUNT_ID);
    expect(tx.cliCredential.update).toHaveBeenCalledTimes(1);
    expect(updateData).toEqual({
      name: `automation~rotated~${CREDENTIAL_ID}`,
      status: 'revoked',
      revokedAt: expect.any(Date),
    });
    expect(tx.cliCredential.create).toHaveBeenCalledTimes(1);
    expect(createData).toEqual({
      id: expect.any(String),
      accountId: ACCOUNT_ID,
      name: 'automation',
      keyHash: expect.any(String),
      scope: 'all_courses',
      status: 'active',
      rotatedFromId: CREDENTIAL_ID,
      createdAt: expect.any(Date),
    });
    expect(createData.keyHash).toBe(hashToken(result.rawKey));
    expect(result.credential).not.toHaveProperty('keyHash');
    expect(result.credential.rotatedFromId).toBe(CREDENTIAL_ID);
    expect(result.rawKey).toBeTruthy();
  });

  it('uses code-point-safe archival names within the database limit', async () => {
    const longUnicodeName = '😀'.repeat(30);
    tx.cliCredential.findUnique.mockResolvedValue(
      predecessor({ name: longUnicodeName }),
    );

    await service.rotateCredential(ACCOUNT_ID, CREDENTIAL_ID);

    const archivalName = tx.cliCredential.update.mock.calls[0][0].data.name;
    expect(archivalName).toBe(`${'😀'.repeat(18)}~rotated~${CREDENTIAL_ID}`);
    expect(Array.from(archivalName).length).toBeLessThanOrEqual(63);
  });

  it.each([
    ['missing account', { account: null }, 'NOT_FOUND'],
    [
      'inactive account',
      { account: { id: ACCOUNT_ID, status: 'disabled' } },
      'FORBIDDEN',
    ],
    ['missing credential', { predecessor: null }, 'NOT_FOUND'],
    [
      'cross-account credential',
      {
        predecessor: predecessor({
          accountId: '01900000-0000-7000-8000-000000000099',
        }),
      },
      'NOT_FOUND',
    ],
    [
      'revoked credential',
      { predecessor: predecessor({ status: 'revoked' }) },
      'CONFLICT',
    ],
    [
      'already rotated credential',
      { predecessor: predecessor({ rotatedTo: { id: SUCCESSOR_ID } }) },
      'CONFLICT',
    ],
  ])('%s does not create a successor', async (_case, setup, code) => {
    if ('account' in setup)
      tx.account.findUnique.mockResolvedValue(setup.account);
    if ('predecessor' in setup)
      tx.cliCredential.findUnique.mockResolvedValue(setup.predecessor);

    await expect(
      service.rotateCredential(ACCOUNT_ID, CREDENTIAL_ID),
    ).rejects.toMatchObject({ code });
    expect(tx.cliCredential.update).not.toHaveBeenCalled();
    expect(tx.cliCredential.create).not.toHaveBeenCalled();
  });

  it('propagates successor persistence failure so no raw key is returned', async () => {
    const persistenceError = new Error('unique successor constraint');
    tx.cliCredential.create.mockRejectedValue(persistenceError);

    await expect(
      service.rotateCredential(ACCOUNT_ID, CREDENTIAL_ID),
    ).rejects.toBe(persistenceError);
    expect(tx.cliCredential.update).toHaveBeenCalledTimes(1);
    expect(tx.cliCredential.create).toHaveBeenCalledTimes(1);
  });

  it('does not touch sessions, validation tokens, or idempotency rows', async () => {
    await service.rotateCredential(ACCOUNT_ID, CREDENTIAL_ID);

    expect(tx).not.toHaveProperty('webSession');
    expect(tx).not.toHaveProperty('questionValidationToken');
    expect(tx).not.toHaveProperty('questionBatchIdempotency');
  });
});
