import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import * as dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma-app/client';
import { bootstrapAdmin } from '../src/bootstrap/bootstrap-admin.core';

import integrationTarget from '../tools/test-db/assert-integration-ready.cjs';

const { assertIntegrationReady } = integrationTarget as {
  assertIntegrationReady: (runId: string) => Promise<{
    runId: string;
    database: string;
    schema: string;
  }>;
};

describe('M03 bootstrap: first system administrator (disposable test DB)', () => {
  let prisma: PrismaClient | undefined;
  let teacherRolelessAccountId: string | undefined;

  beforeAll(async () => {
    const runId = process.env.TEST_DB_RUN_ID;
    if (!runId)
      throw new Error(
        'Set TEST_DB_RUN_ID to the explicit fresh test database run ID.',
      );
    const verified = await assertIntegrationReady(runId);
    if (verified.database !== 'smartlearning_test') {
      throw new Error(
        'Integration DB identity verification returned an unexpected target.',
      );
    }
    prisma = await createPinnedClient('.env.test', 'smartlearning_test');

    // Fixture: one ACTIVE account with no role, used for the safe-stop case.
    teacherRolelessAccountId = (
      await prisma.user_account.create({
        data: {
          email: `m03bx-norole-${randomUUID()}@example.test`,
          email_verified: true,
          password_hash: await argon2.hash('fixture-only-password'),
          name: 'M03 Bootstrap Fixture',
          account_name: `m03bx-${randomUUID().replaceAll('-', '').slice(0, 20)}`,
          status: 'ACTIVE',
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      if (prisma && teacherRolelessAccountId) {
        const affected = await collectBootstrapAccounts(prisma);
        await prisma.$transaction(async (tx) => {
          await tx.user_role.deleteMany({
            where: { user_account_id: { in: affected } },
          });
          await tx.user_account.deleteMany({ where: { id: { in: affected } } });
        });
        await prisma.$transaction(async (tx) => {
          await tx.user_account.deleteMany({
            where: { id: teacherRolelessAccountId as string },
          });
        });
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      await prisma?.$disconnect();
    }
    if (cleanupError) throw cleanupError;
  });

  it('creates the first ACTIVE system administrator and its assignment in one transaction', async () => {
    if (!prisma) throw new Error('Integration setup did not complete.');
    const email = `bootstrap-${randomUUID()}@example.test`;
    const password = randomUUID() + randomUUID();
    const result = await bootstrapAdmin(prisma, {
      email,
      name: '首位管理者',
      password,
    });
    expect(result.outcome).toBe('CREATED');
    expect(result.accountId).toEqual(expect.any(String));

    const account = await prisma.user_account.findUniqueOrThrow({
      where: { id: result.accountId as string },
    });
    expect(account.email).toBe(email);
    expect(account.status).toBe('ACTIVE');
    expect(account.email_verified).toBe(true);
    expect(account.password_hash.startsWith('$argon2')).toBe(true);
    await expect(argon2.verify(account.password_hash, password)).resolves.toBe(
      true,
    );

    const assignments = await prisma.user_role.findMany({
      where: { user_account_id: account.id },
      include: { role: true },
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].role.role_code).toBe('SYSTEM_ADMIN');
    expect(assignments[0].assigned_by).toBeNull();
  });

  it('is idempotent: rerunning on a bootstrapped environment reports and changes nothing', async () => {
    if (!prisma) throw new Error('Integration setup did not complete.');
    const email = `bootstrap-${randomUUID()}@example.test`;
    await bootstrapAdmin(prisma, {
      email,
      name: '首位管理者',
      password: 'longenough-password',
    });
    const before = await countAccountsAndAssignments(prisma, email);
    await expect(
      bootstrapAdmin(prisma, {
        email,
        name: '首位管理者',
        password: 'longenough-password',
      }),
    ).resolves.toEqual({ outcome: 'ALREADY_BOOTSTRAPPED' });
    const after = await countAccountsAndAssignments(prisma, email);
    expect(after).toEqual(before);
  });

  it('safely stops when the email exists without an active SYSTEM_ADMIN assignment', async () => {
    if (!prisma || !teacherRolelessAccountId)
      throw new Error('Integration setup did not complete.');
    const account = await prisma.user_account.findUniqueOrThrow({
      where: { id: teacherRolelessAccountId },
      select: { email: true },
    });
    const assignmentsBefore = await prisma.user_role.count({
      where: { user_account_id: teacherRolelessAccountId },
    });
    await expect(
      bootstrapAdmin(prisma, {
        email: account.email,
        name: '首位管理者',
        password: 'longenough-password',
      }),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_ACCOUNT_CONFLICT' });
    expect(
      await prisma.user_role.count({
        where: { user_account_id: teacherRolelessAccountId },
      }),
    ).toBe(assignmentsBefore);
  });

  it('refuses a password shorter than the policy and rolls back completely', async () => {
    if (!prisma) throw new Error('Integration setup did not complete.');
    const email = `bootstrap-${randomUUID()}@example.test`;
    await expect(
      bootstrapAdmin(prisma, { email, name: '首位管理者', password: 'short' }),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_PASSWORD_INVALID' });
    expect(await prisma.user_account.count({ where: { email } })).toBe(0);
  });
});

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

async function countAccountsAndAssignments(
  prisma: PrismaClient,
  email: string,
): Promise<{ accounts: number; activeAdminAssignments: number }> {
  const rows = await prisma.$queryRaw<
    Array<{ accounts: number; activeAdminAssignments: number }>
  >`
    SELECT
      count(DISTINCT account.id)::int AS accounts,
      (
        SELECT count(*)::int
        FROM app.user_role AS assignment
        JOIN app.role AS assigned_role ON assigned_role.id = assignment.role_id
        JOIN app.user_account AS owner ON owner.id = assignment.user_account_id
        WHERE lower(owner.email) = ${email}
          AND assigned_role.role_code = 'SYSTEM_ADMIN'
      ) AS "activeAdminAssignments"
    FROM app.user_account AS account
    WHERE lower(account.email) = ${email}
  `;
  return rows[0] ?? { accounts: 0, activeAdminAssignments: 0 };
}

async function collectBootstrapAccounts(
  prisma: PrismaClient,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT account.id
    FROM app.user_account AS account
    JOIN app.user_role AS assignment ON assignment.user_account_id = account.id
    JOIN app.role AS assigned_role ON assigned_role.id = assignment.role_id
    WHERE assigned_role.role_code = 'SYSTEM_ADMIN'
      AND account.account_name LIKE 'bootstrap-%'
  `;
  return rows.map((row) => row.id);
}
