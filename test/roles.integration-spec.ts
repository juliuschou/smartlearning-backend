// M02 integration spec: verifies that the fixed SYSTEM_ADMIN / TEACHER roles and the
// M02 permission catalog were correctly established by migration
// prisma/migrations/20261122000000_add_m02_role_management_permissions/.
//
// IMPORTANT: this spec is read-only. It creates no fixtures, sends no HTTP requests,
// and never boots the Nest application, so a disposable test-DB run stays "clean"
// after it finishes.
//
// Standard (disposable test DB) execution:
//   npm run db:test:preflight
//   npm run db:test:up                                   # note the printed run_id
//   npm run db:test:assert-integration -- <run_id>
//   TEST_DB_RUN_ID=<run_id> NODE_ENV=test \
//     npm run test:integration -- --testPathPattern roles.integration-spec
//   npm run db:test:down -- <run_id>
//
// Development database check (READ-ONLY, opt-in, requires explicit authorization):
//   TEST_DB_TARGET=dev DEV_DB_CHECK_AUTHORIZED=YES NODE_ENV=test \
//     npx jest --config ./test/jest-integration.json --runInBand \
//     --testPathPattern roles.integration-spec -t "dev"
// This mode only runs SELECT assertions against the development database loaded from
// .env.development. It is never part of npm scripts and must never run unattended.

import * as dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma-app/client';

import integrationTarget from '../tools/test-db/assert-integration-ready.cjs';

const { assertTestTarget } = integrationTarget as {
  assertTestTarget: (
    runId: string,
    options?: { requireEmpty?: boolean },
  ) => Promise<{
    runId: string;
    database: string;
    schema: string;
    migrationCount: number;
  }>;
};

// Expected seed values, mirroring the migration SQL exactly.
const EXPECTED_ROLES: Array<{
  roleCode: string;
  name: string;
  description: string;
}> = [
  {
    roleCode: 'SYSTEM_ADMIN',
    name: '系統管理者',
    description: '管理平台帳號、角色、功能授權及系統設定；不自動取得授課能力。',
  },
  {
    roleCode: 'TEACHER',
    name: '老師',
    description: '維護自己的題庫、建立並主持教學活動、檢視自己的報表。',
  },
];

const EXPECTED_PERMISSIONS: Array<{
  permissionCode: string;
  name: string;
  description: string;
  moduleCategory: string;
}> = [
  {
    permissionCode: 'M02_READ',
    name: '角色檢視',
    description: '查詢固定角色清單、角色明細及角色目前的功能授權摘要。',
    moduleCategory: '角色',
  },
  {
    permissionCode: 'M02_WRITE',
    name: '角色狀態維護',
    description: '啟用或停用固定角色；不得修改角色基本資料或刪除角色。',
    moduleCategory: '角色',
  },
];

// Dev-mode guards, evaluated once at load time.
const DEV_MODE = process.env.TEST_DB_TARGET === 'dev';
const DEV_AUTHORIZED = process.env.DEV_DB_CHECK_AUTHORIZED === 'YES';
if (DEV_MODE && !DEV_AUTHORIZED) {
  // Fail loudly on an accidental opt-in: TEST_DB_TARGET=dev without the explicit
  // authorization flag must never silently fall through to skips.
  throw new Error(
    'TEST_DB_TARGET=dev requires DEV_DB_CHECK_AUTHORIZED=YES (explicit authorization).',
  );
}

/**
 * Shared read-only assertions for the role/permission seed. Every query is a SELECT;
 * the caller owns connect/disconnect.
 */
async function runSeedAssertions(prisma: PrismaClient): Promise<void> {
  // 1. Roles: exactly SYSTEM_ADMIN + TEACHER, exact catalog values.
  const roles = await prisma.role.findMany({
    where: { role_code: { in: EXPECTED_ROLES.map((r) => r.roleCode) } },
  });
  expect(roles).toHaveLength(EXPECTED_ROLES.length);
  for (const expected of EXPECTED_ROLES) {
    const role = roles.find((r) => r.role_code === expected.roleCode);
    expect(role).toBeDefined();
    expect(role?.name).toBe(expected.name);
    expect(role?.description).toBe(expected.description);
    expect(role?.is_system_reserved).toBe(true);
    expect(role?.status).toBe('ENABLED');
  }

  // 2. Permissions: exactly M02_READ + M02_WRITE, ENABLED.
  const permissions = await prisma.permission.findMany({
    where: {
      permission_code: {
        in: EXPECTED_PERMISSIONS.map((p) => p.permissionCode),
      },
    },
  });
  expect(permissions).toHaveLength(EXPECTED_PERMISSIONS.length);
  for (const expected of EXPECTED_PERMISSIONS) {
    const permission = permissions.find(
      (p) => p.permission_code === expected.permissionCode,
    );
    expect(permission?.name).toBe(expected.name);
    expect(permission?.description).toBe(expected.description);
    expect(permission?.module_category).toBe(expected.moduleCategory);
    expect(permission?.status).toBe('ENABLED');
  }

  // 3. Role-permission mapping: only SYSTEM_ADMIN gets both M02 permissions;
  //    TEACHER has none.
  const mapping = await prisma.role_permission.findMany({
    where: { permission_id: { in: permissions.map((p) => p.id) } },
    include: { role: true, permission: true },
  });
  const systemAdminRows = mapping.filter(
    (row) => row.role.role_code === 'SYSTEM_ADMIN',
  );
  const teacherRows = mapping.filter((row) => row.role.role_code === 'TEACHER');
  expect(
    systemAdminRows.map((row) => row.permission.permission_code).sort(),
  ).toEqual(['M02_READ', 'M02_WRITE']);
  expect(teacherRows).toHaveLength(0);
}

/**
 * Builds a standalone PrismaClient whose URL is pinned to the database named
 * `expectedDatabaseName`. Refuses to connect to anything else, so a misconfigured
 * env file can never route dev checks at the test DB (or vice versa), and refuses
 * any non-loopback host. Read-only spec; client is only used for SELECTs.
 */
async function createPinnedClient(
  envPath: string,
  expectedDatabaseName: string,
): Promise<PrismaClient> {
  const env = dotenv.config({ path: envPath, quiet: true });
  const url = env.parsed?.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error(`DATABASE_URL is required in ${envPath}`);

  const parsed = new URL(url);
  const databaseName = parsed.pathname.replace(/^\//, '');
  if (databaseName !== expectedDatabaseName) {
    throw new Error(
      `${envPath} DATABASE_URL points at '${databaseName}', expected '${expectedDatabaseName}'.`,
    );
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(
      `Refusing to connect to non-loopback host '${parsed.hostname}'.`,
    );
  }

  parsed.searchParams.set('schema', 'app');
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: parsed.toString(),
      connectionTimeoutMillis: 5000,
    }),
  });
}

describe('M02 role seed on disposable test database (read-only)', () => {
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    const runId = process.env.TEST_DB_RUN_ID;
    if (!runId)
      throw new Error(
        'Set TEST_DB_RUN_ID to the explicit fresh test database run ID.',
      );
    // Pins the target to the disposable run (container identity, loopback port,
    // migration ledger) before any connection happens. requireEmpty is off because
    // this spec verifies migration-seeded catalog rows themselves.
    const verified = await assertTestTarget(runId, { requireEmpty: false });
    if (
      verified.database !== 'smartlearning_test' ||
      verified.schema !== 'app'
    ) {
      throw new Error(
        'Integration DB identity verification returned an unexpected target.',
      );
    }
    prisma = await createPinnedClient('.env.test', 'smartlearning_test');
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('establishes the fixed SYSTEM_ADMIN and TEACHER roles with the exact catalog values', async () => {
    await runSeedAssertions(prisma!);
  });

  it('maps M02 permissions only to SYSTEM_ADMIN; TEACHER has none', async () => {
    // Covered by the third assertion inside runSeedAssertions; kept as a named case
    // so the acceptance scenario reads explicitly.
    await runSeedAssertions(prisma!);
  });
});

describe('M02 dev database seed verification (read-only, opt-in)', () => {
  // Uses conditional test registration: in default runs this whole block is skipped,
  // and it touches only the dev DB when both env vars are set explicitly.
  const itDev = DEV_MODE ? it : it.skip;

  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    if (!DEV_MODE) return;
    prisma = await createPinnedClient('.env.development', 'smartlearning_dev');
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  itDev(
    'establishes the same fixed roles and permission mapping in the dev database',
    async () => {
      await runSeedAssertions(prisma!);
    },
  );
});
