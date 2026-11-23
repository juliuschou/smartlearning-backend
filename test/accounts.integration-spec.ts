import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthConfig } from '../src/auth/auth.config';
import { PrismaService } from '../src/database/prisma.service';

import integrationTarget from '../tools/test-db/assert-integration-ready.cjs';

const { assertIntegrationReady } = integrationTarget as {
  assertIntegrationReady: (runId: string) => Promise<{
    runId: string;
    database: string;
    schema: string;
  }>;
};

type Fixture = {
  accounts: {
    admin: { id: string; email: string };
    teacher: { id: string; email: string };
  };
  password: string;
  createdAccounts: string[];
};

describe('M03 teacher account creation on disposable test database', () => {
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let prisma: PrismaService['client'] | undefined;
  let fixture: Fixture | undefined;
  let origin: string;

  async function createApplication() {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const application = module.createNestApplication();
    application.use(cookieParser());
    // 與 src/main.ts 相同的全域 ValidationPipe（整合測試不走 main.ts bootstrap）。
    application.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await application.init();
    return application;
  }

  beforeAll(async () => {
    // 邀請信使用與密碼重設共用的加密 outbox；整合測試只驗證資料面（連結與 outbox 工作），
    // 不實際寄信，故注入一次性 fixture 值。
    process.env.EMAIL_OUTBOX_ENABLED = 'true';
    process.env.PASSWORD_RESET_URL = 'http://localhost:3001/reset';
    process.env.TEACHER_INVITATION_URL = 'http://localhost:3001/invite';
    process.env.RESET_OUTBOX_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      'base64',
    );

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
    app = await createApplication();
    const config = app.get(AuthConfig);
    const configuredOrigin = config.allowedOrigins.values().next().value;
    if (!configuredOrigin)
      throw new Error(
        'The test configuration must contain an exact CORS_ORIGIN.',
      );
    origin = configuredOrigin;
    prisma = app.get(PrismaService).client;
    fixture = await createFixture(prisma);
  });

  afterAll(async () => {
    let cleanupError: unknown;
    try {
      if (prisma && fixture) await removeFixture(prisma, fixture);
    } catch (error) {
      cleanupError = error;
    } finally {
      await app?.close();
    }
    if (cleanupError) throw cleanupError;
  });

  async function loginAs(
    client: ReturnType<typeof request.agent>,
    email: string,
  ): Promise<string> {
    const csrf = await client.get('/auth/csrf').expect(200);
    const login = await client
      .post('/auth/login')
      .set('Origin', origin)
      .set('x-csrf-token', csrf.body.csrfToken as string)
      .send({ email, password: fixture!.password })
      .expect(200);
    return login.body.csrfToken as string;
  }

  it('creates the teacher as INVITED with TEACHER role, invitation link, and mail job in one transaction', async () => {
    if (!app || !fixture || !prisma)
      throw new Error('Integration setup did not complete.');
    const adminClient = request.agent(app.getHttpServer());
    const csrfToken = await loginAs(adminClient, fixture.accounts.admin.email);

    const payload = {
      name: '測試老師',
      accountName: `t${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      email: `teacher-${randomUUID()}@example.test`,
    };
    const created = await adminClient
      .post('/teachers')
      .set('Origin', origin)
      .set('x-csrf-token', csrfToken)
      .send(payload)
      .expect(201);
    fixture.createdAccounts.push(created.body.accountId as string);

    expect(created.body).toEqual({
      accountId: expect.any(String),
      status: 'INVITED',
      name: payload.name,
      accountName: payload.accountName,
      email: payload.email,
      roles: ['TEACHER'],
      inviteExpiresAt: expect.any(String),
    });
    expect(JSON.stringify(created.body)).not.toContain('password');
    expect(JSON.stringify(created.body)).not.toContain('token');

    const account = await prisma.user_account.findUniqueOrThrow({
      where: { id: created.body.accountId as string },
    });
    expect(account.status).toBe('INVITED');
    expect(account.email_verified).toBe(false);
    expect(account.name).toBe(payload.name);
    expect(account.account_name).toBe(payload.accountName);
    expect(account.email).toBe(payload.email);

    const assignment = await prisma.user_role.findFirstOrThrow({
      where: { user_account_id: account.id },
      include: { role: true },
    });
    expect(assignment.role.role_code).toBe('TEACHER');
    expect(assignment.assigned_by).toBe(fixture.accounts.admin.id);

    const link = await prisma.one_time_link.findFirstOrThrow({
      where: { user_account_id: account.id, kind: 'INVITATION' },
    });
    expect(link.status).toBe('PENDING');
    expect(link.token_hash).not.toBe('');
    const expectedExpiry =
      new Date(link.created_at).getTime() + 7 * 24 * 3600 * 1000;
    expect(
      Math.abs(new Date(link.expires_at).getTime() - expectedExpiry),
    ).toBeLessThan(10_000);

    const mailJob = await prisma.email_outbox.findFirstOrThrow({
      where: { related_id: link.id, purpose: 'TEACHER_INVITATION' },
    });
    expect(mailJob.status).toBe('PENDING');
    expect(mailJob.encrypted_payload).not.toContain(payload.email);
  });

  it('rejects an unauthenticated request', async () => {
    if (!app) throw new Error('Integration setup did not complete.');
    // 全域 CSRF guard 先於 session guard（比照 auth spec）；先取未登入 CSRF 權杖，
    // 驗證 CSRF 通過後 session guard 以 401 拒絕未登入的建立請求。
    const client = request.agent(app.getHttpServer());
    const csrf = await client.get('/auth/csrf').expect(200);
    await client
      .post('/teachers')
      .set('Origin', origin)
      .set('x-csrf-token', csrf.body.csrfToken as string)
      .send({ name: 'x', accountName: 'abc', email: 'a@b.test' })
      .expect(401);
  });

  it('rejects a teacher-role caller without the M03 permission', async () => {
    if (!app || !fixture)
      throw new Error('Integration setup did not complete.');
    const teacherClient = request.agent(app.getHttpServer());
    const csrfToken = await loginAs(
      teacherClient,
      fixture.accounts.teacher.email,
    );
    const denied = await teacherClient
      .post('/teachers')
      .set('Origin', origin)
      .set('x-csrf-token', csrfToken)
      .send({
        name: '另一个老师',
        accountName: `t${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        email: `teacher-${randomUUID()}@example.test`,
      })
      .expect(403);
    expect(denied.body).toEqual({
      code: 'M03_PERMISSION_REQUIRED',
      message: expect.any(String),
    });
  });

  it('rejects duplicate email and account name case-insensitively, creating nothing', async () => {
    if (!app || !fixture || !prisma)
      throw new Error('Integration setup did not complete.');
    const adminClient = request.agent(app.getHttpServer());
    const csrfToken = await loginAs(adminClient, fixture.accounts.admin.email);

    const first = {
      name: '重複測試老師',
      accountName: `dup${randomUUID().replaceAll('-', '').slice(0, 10)}`,
      email: `dup-${randomUUID()}@example.test`,
    };
    const created = await adminClient
      .post('/teachers')
      .set('Origin', origin)
      .set('x-csrf-token', csrfToken)
      .send(first)
      .expect(201);
    fixture.createdAccounts.push(created.body.accountId as string);

    const emailConflict = await adminClient
      .post('/teachers')
      .set('Origin', origin)
      .set('x-csrf-token', csrfToken)
      .send({
        ...first,
        email: first.email.toUpperCase(),
        accountName: `other${randomUUID().replaceAll('-', '').slice(0, 8)}`,
      })
      .expect(409);
    expect(emailConflict.body.code).toBe('EMAIL_ALREADY_EXISTS');

    const nameConflict = await adminClient
      .post('/teachers')
      .set('Origin', origin)
      .set('x-csrf-token', csrfToken)
      .send({
        ...first,
        accountName: first.accountName.toUpperCase(),
        email: `other-${randomUUID()}@example.test`,
      })
      .expect(409);
    expect(nameConflict.body.code).toBe('ACCOUNT_NAME_ALREADY_EXISTS');

    // 衝突即冪等：不建立第二個帳號，也沒有新的邀請連結。
    expect(
      await prisma.user_account.count({
        where: { email: { in: [first.email, first.email.toUpperCase()] } },
      }),
    ).toBe(1);
    expect(
      await prisma.one_time_link.count({
        where: { user_account_id: created.body.accountId as string },
      }),
    ).toBe(1);
  });

  it('rejects invalid payloads with 400 and never creates an account', async () => {
    if (!app || !fixture || !prisma)
      throw new Error('Integration setup did not complete.');
    const adminClient = request.agent(app.getHttpServer());
    const csrfToken = await loginAs(adminClient, fixture.accounts.admin.email);

    const base = {
      name: '格式測試老師',
      accountName: `ok${randomUUID().replaceAll('-', '').slice(0, 10)}`,
      email: `ok-${randomUUID()}@example.test`,
    };
    const cases = [
      { ...base, name: '' },
      { ...base, name: 'a'.repeat(101) },
      { ...base, accountName: 'ab' },
      { ...base, accountName: 'teacher account!' },
      { ...base, email: 'not-an-email' },
      { ...base, email: `x${'y'.repeat(250)}@example.test` },
      { ...base, phone: '0912-345-678' },
      { ...base, unexpected: true },
    ];
    for (const payload of cases) {
      const response = await adminClient
        .post('/teachers')
        .set('Origin', origin)
        .set('x-csrf-token', csrfToken)
        .send(payload as Record<string, unknown>);
      expect(response.status).toBe(400);
      expect(
        await prisma.user_account.count({ where: { name: '格式測試老師' } }),
      ).toBe(0);
    }
  });

  it('rejects mutations without a CSRF token or with an untrusted Origin', async () => {
    if (!app || !fixture)
      throw new Error('Integration setup did not complete.');
    const adminClient = request.agent(app.getHttpServer());
    const csrfToken = await loginAs(adminClient, fixture.accounts.admin.email);

    const payload = {
      name: 'csrf 老師',
      accountName: `c${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      email: `csrf-${randomUUID()}@example.test`,
    };
    await adminClient
      .post('/teachers')
      .set('Origin', origin)
      .send(payload)
      .expect(403);
    await adminClient
      .post('/teachers')
      .set('Origin', 'https://untrusted.invalid')
      .set('x-csrf-token', csrfToken)
      .send(payload)
      .expect(403);
  });
});

async function createFixture(
  prisma: PrismaService['client'],
): Promise<Fixture> {
  const suffix = randomUUID().replaceAll('-', '');
  const password = randomBytes(32).toString('base64url');
  const passwordHash = await argon2.hash(password);

  return prisma.$transaction(async (tx) => {
    // SYSTEM_ADMIN 與 TEACHER 角色由 migration 20261122000000 種入，只查詢，不建立或刪除。
    const roles = await tx.role.findMany({
      where: { role_code: { in: ['SYSTEM_ADMIN', 'TEACHER'] } },
      select: { id: true, role_code: true },
    });
    const systemAdminRole = roles.find(
      (role) => role.role_code === 'SYSTEM_ADMIN',
    )!;
    const teacherRole = roles.find((role) => role.role_code === 'TEACHER')!;

    const createAccount = async (
      tag: string,
      roleIds: string[],
    ): Promise<{ id: string; email: string }> => {
      const account = await tx.user_account.create({
        data: {
          email: `m03-${tag}-${suffix}@example.test`,
          email_verified: true,
          password_hash: passwordHash,
          name: 'M03 Integration Fixture',
          account_name: `m03-${tag}-${suffix.slice(0, 14)}`,
          status: 'ACTIVE',
        },
        select: { id: true, email: true },
      });
      for (const roleId of roleIds) {
        await tx.user_role.create({
          data: { user_account_id: account.id, role_id: roleId },
        });
      }
      return account;
    };

    const admin = await createAccount('admin', [systemAdminRole.id]);
    const teacher = await createAccount('teacher', [teacherRole.id]);
    return {
      accounts: { admin, teacher },
      password,
      createdAccounts: [],
    };
  });
}

async function removeFixture(
  prisma: PrismaService['client'],
  fixture: Fixture,
): Promise<void> {
  const fixedAccountIds = Object.values(fixture.accounts).map(
    (account) => account.id,
  );
  const ids = [...fixedAccountIds, ...fixture.createdAccounts];
  await prisma.$transaction(async (tx) => {
    await tx.email_outbox.deleteMany({
      where: {
        related_id: {
          in: (
            await tx.one_time_link.findMany({
              where: { user_account_id: { in: ids } },
              select: { id: true },
            })
          ).map((link) => link.id),
        },
      },
    });
    await tx.one_time_link.deleteMany({
      where: { user_account_id: { in: ids } },
    });
    await tx.user_role.deleteMany({
      where: {
        OR: [{ user_account_id: { in: ids } }, { assigned_by: { in: ids } }],
      },
    });
    await tx.login_session.deleteMany({
      where: { user_account_id: { in: ids } },
    });
    await tx.user_account.deleteMany({ where: { id: { in: ids } } });
  });
}
