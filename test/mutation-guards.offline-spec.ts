import { createHash } from 'node:crypto';

jest.mock('dotenv', () => ({
  __esModule: true,
  default: { config: jest.fn() },
}));
jest.mock('node:fs', () => ({ readFileSync: jest.fn() }));
jest.mock('child_process', () => ({ execSync: jest.fn() }));
jest.mock('pg', () => ({ Client: jest.fn() }));

import { readFileSync } from 'node:fs';
import { execSync } from 'child_process';
import { Client } from 'pg';
import dotenv from 'dotenv';

const contract = {
  db: 'smartlearning_test',
  role: 'test_role',
  schema: 'public',
  cluster: 'reviewed-cluster',
  system: '123456789',
  recovery: false,
  endpoint: 'postgresql://test_role:fake@127.0.0.1:55433/smartlearning_test',
};
const originalEnv = { ...process.env };
const query = jest.fn();
const mutate = jest.fn();
const connect = jest.fn();
const end = jest.fn();

beforeEach(() => {
  jest.resetModules();
  jest.doMock('dotenv', () => ({ __esModule: true, default: dotenv }));
  jest.doMock('node:fs', () => ({ readFileSync }));
  jest.doMock('child_process', () => ({ execSync }));
  jest.doMock('pg', () => ({ Client }));
  jest.clearAllMocks();
  process.env = {
    ...originalEnv,
    NODE_ENV: 'test',
    DATABASE_URL: contract.endpoint,
    TEST_DB_MUTATIONS: 'migrate,truncate',
    TEST_DB_CONTRACT: '/mock/contract.json',
  };
  const bytes = Buffer.from(JSON.stringify(contract));
  process.env.TEST_DB_CONTRACT_SHA256 = createHash('sha256')
    .update(bytes)
    .digest('hex');
  jest.mocked(readFileSync).mockReturnValue(bytes);
  query.mockReset().mockResolvedValue({ rows: [contract] });
  connect.mockReset().mockResolvedValue(undefined);
  end.mockReset().mockResolvedValue(undefined);
  mutate.mockReset().mockResolvedValue(undefined);
  jest
    .mocked(Client)
    .mockImplementation(() => ({ connect, query, end }) as unknown as Client);
});
afterEach(() => {
  process.env = { ...originalEnv };
});

async function runBoth(reject = true) {
  const { setupTestDb, truncateAll } = await import('./setup/db');
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string) =>
      sql.startsWith('SET') ? [] : ((await query()).rows as unknown),
    ),
    $queryRaw: mutate,
  };
  const prisma = {
    $transaction: jest.fn(async (work: (value: typeof tx) => Promise<void>) =>
      work(tx),
    ),
  };
  if (reject) {
    await expect(setupTestDb()).rejects.toThrow('BLOCKED:');
    await expect(truncateAll(prisma)).rejects.toThrow('BLOCKED:');
    expect(execSync).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  } else {
    await setupTestDb();
    await truncateAll(prisma);
    expect(execSync).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  }
}

test.each(['db', 'role', 'schema', 'cluster', 'system', 'recovery'])(
  'rejects wrong %s before either mutation',
  async (key) => {
    query.mockResolvedValue({
      rows: [{ ...contract, [key]: key === 'recovery' ? true : 'wrong' }],
    });
    await runBoth();
  },
);
test.each(
  [[], [null], [{ db: 'smartlearning_test' }], [contract, contract]].map(
    (rows) => ({ rows }),
  ),
)('rejects malformed identity $rows', async ({ rows }) => {
  query.mockResolvedValue({ rows });
  await runBoth();
});
test.each(['unavailable', 'timeout', 'permission denied'])(
  'rejects %s without leaking diagnostics',
  async (message) => {
    query.mockRejectedValue(new Error(message));
    await runBoth();
  },
);
test('rejects development', async () => {
  process.env.NODE_ENV = 'development';
  await runBoth();
});
test('rejects missing authorization', async () => {
  delete process.env.TEST_DB_MUTATIONS;
  await runBoth();
});
test('rejects missing contract', async () => {
  jest.mocked(readFileSync).mockImplementation(() => {
    throw new Error('missing');
  });
  await runBoth();
});
test('rejects unpinned contract', async () => {
  process.env.TEST_DB_CONTRACT_SHA256 = 'wrong';
  await runBoth();
});
test('rejects a changed endpoint', async () => {
  process.env.DATABASE_URL += '?schema=other';
  await runBoth();
});
test('permits explicitly authorized matching target through both entry points', async () => {
  await runBoth(false);
});

test('dotenv cannot grant authorization or change a development launch into test', async () => {
  process.env.NODE_ENV = 'development';
  delete process.env.TEST_DB_MUTATIONS;
  const guard = await import('./setup/mutation-guard');
  process.env.NODE_ENV = 'test';
  process.env.TEST_DB_MUTATIONS = 'migrate,truncate';
  expect(() => guard.mutationContract('migrate')).toThrow('BLOCKED:');
});
test('migration-only authorization cannot grant truncate', async () => {
  process.env.TEST_DB_MUTATIONS = 'migrate';
  const { truncateAll } = await import('./setup/db');
  const transaction = jest.fn();
  await expect(truncateAll({ $transaction: transaction })).rejects.toThrow(
    'BLOCKED:',
  );
  expect(transaction).not.toHaveBeenCalled();
});

test('env-file source URL cannot replace the authorized isolated launcher URL', async () => {
  const actualDotenv = jest.requireActual<typeof import('dotenv')>('dotenv');
  jest.mocked(dotenv.config).mockImplementation((options) => {
    actualDotenv.populate(
      process.env,
      {
        DATABASE_URL:
          'postgresql://test_role:fake@127.0.0.1:5432/smartlearning_test',
      },
      { override: options?.override },
    );
    return {};
  });
  await runBoth(false);
  expect(process.env.DATABASE_URL).toBe(contract.endpoint);
  expect(execSync).toHaveBeenCalledWith(
    'npx prisma migrate deploy',
    expect.objectContaining({
      env: expect.objectContaining({ DATABASE_URL: contract.endpoint }),
    }),
  );
});
