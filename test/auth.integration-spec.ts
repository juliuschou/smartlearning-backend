import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import request from 'supertest';
import { role_status_e, user_status_e } from '../generated/prisma-app/client';
import { AppModule } from '../src/app.module';
import { AuthConfig } from '../src/auth/auth.config';
import { AuthSecurityService } from '../src/auth/auth-security.service';
import { PrismaService } from '../src/database/prisma.service';

import integrationTarget from '../tools/test-db/assert-integration-ready.cjs';

const { assertIntegrationReady } = integrationTarget as {
  assertIntegrationReady: (runId: string) => Promise<{
    runId: string;
    database: string;
    schema: string;
    migrationCount: number;
  }>;
};

type Fixture = {
  roleId: string;
  accounts: {
    active: { id: string; email: string };
    disabled: { id: string; email: string };
    unverified: { id: string; email: string };
    roleless: { id: string; email: string };
  };
  password: string;
};

describe('Checkpoint B PostgreSQL authentication acceptance', () => {
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
    await application.init();
    return application;
  }

  beforeAll(async () => {
    const runId = process.env.TEST_DB_RUN_ID;
    if (!runId)
      throw new Error(
        'Set TEST_DB_RUN_ID to the explicit fresh test database run ID.',
      );
    const verified = await assertIntegrationReady(runId);
    if (
      verified.database !== 'smartlearning_test' ||
      verified.schema !== 'app'
    ) {
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

  it('creates and persists a login Session, then revokes it on Logout', async () => {
    if (!app || !fixture || !prisma)
      throw new Error('Integration setup did not complete.');
    const client = request.agent(app.getHttpServer());
    const csrf = await client.get('/auth/csrf').expect(200);
    expect(csrf.body.csrfToken).toEqual(expect.any(String));

    const login = await client
      .post('/auth/login')
      .set('Origin', origin)
      .set('x-csrf-token', csrf.body.csrfToken as string)
      .send({
        email: fixture.accounts.active.email,
        password: fixture.password,
      })
      .expect(200);
    expect(login.body).toEqual({
      authenticated: true,
      csrfToken: expect.any(String),
    });
    expect(JSON.stringify(login.body)).not.toContain(fixture.password);

    const setCookieHeader = login.headers['set-cookie'];
    const setCookies = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : [];
    const sessionCookie = getCookie(setCookies, 'sl_session');
    if (!sessionCookie)
      throw new Error('Login response did not set the session cookie.');
    expect(setCookies.join(';')).toContain('HttpOnly');
    expect(setCookies.join(';')).toContain('SameSite=Lax');
    const sessionTokenHash = app
      .get(AuthSecurityService)
      .hashSessionCredential(sessionCookie);
    const savedSession = await prisma.login_session.findUnique({
      where: { token_hash: sessionTokenHash },
    });
    expect(savedSession).toMatchObject({
      user_account_id: fixture.accounts.active.id,
      status: 'ACTIVE',
    });
    expect(savedSession?.token_hash).not.toBe(sessionCookie);

    await client
      .get('/auth/login-session')
      .expect(200, { authenticated: true });
    await client
      .post('/auth/logout')
      .set('Origin', origin)
      .set('x-csrf-token', login.body.csrfToken as string)
      .send({})
      .expect(204);

    const revokedSession = await prisma.login_session.findUnique({
      where: { token_hash: sessionTokenHash },
    });
    expect(revokedSession).toMatchObject({ status: 'REVOKED' });
    expect(revokedSession?.revoked_at).toBeInstanceOf(Date);
    await client.get('/auth/login-session').expect(401);
  });

  it('returns one generic failure for invalid account states and credentials', async () => {
    if (!app || !fixture || !prisma)
      throw new Error('Integration setup did not complete.');
    const sessionCountBefore = await prisma.login_session.count({
      where: { user_account_id: fixture.accounts.active.id },
    });
    const cases = [
      { email: fixture.accounts.disabled.email, password: fixture.password },
      { email: fixture.accounts.unverified.email, password: fixture.password },
      { email: fixture.accounts.roleless.email, password: fixture.password },
      {
        email: fixture.accounts.active.email,
        password: 'incorrect-test-password',
      },
      {
        email: `missing-${randomUUID()}@example.test`,
        password: fixture.password,
      },
    ];
    const failures: unknown[] = [];
    for (const credentials of cases) {
      const client = request.agent(app.getHttpServer());
      const csrf = await client.get('/auth/csrf').expect(200);
      const response = await client
        .post('/auth/login')
        .set('Origin', origin)
        .set('x-csrf-token', csrf.body.csrfToken as string)
        .send(credentials)
        .expect(401);
      failures.push(response.body);
    }
    expect(
      failures.every(
        (body) => JSON.stringify(body) === JSON.stringify(failures[0]),
      ),
    ).toBe(true);
    expect(JSON.stringify(failures)).not.toContain(fixture.password);
    const sessionCountAfter = await prisma.login_session.count({
      where: { user_account_id: fixture.accounts.active.id },
    });
    expect(sessionCountAfter).toBe(sessionCountBefore);
  });

  it('rejects missing or untrusted CSRF/Origin on login and logout mutations', async () => {
    if (!app || !fixture)
      throw new Error('Integration setup did not complete.');
    const client = request.agent(app.getHttpServer());
    const csrf = await client.get('/auth/csrf').expect(200);

    await client
      .post('/auth/login')
      .set('Origin', origin)
      .send({
        email: fixture.accounts.active.email,
        password: fixture.password,
      })
      .expect(403);
    await client
      .post('/auth/login')
      .set('Origin', 'https://untrusted.invalid')
      .set('x-csrf-token', csrf.body.csrfToken as string)
      .send({
        email: fixture.accounts.active.email,
        password: fixture.password,
      })
      .expect(403);
    await client
      .post('/auth/logout')
      .set('Origin', origin)
      .send({})
      .expect(403);
  });
});

async function createFixture(
  prisma: PrismaService['client'],
): Promise<Fixture> {
  const suffix = randomUUID().replaceAll('-', '');
  const emailBase = `m01-${suffix}`;
  const password = randomBytes(32).toString('base64url');
  const passwordHash = await argon2.hash(password);

  return prisma.$transaction(async (tx) => {
    const role = await tx.role.create({
      data: {
        role_code: 'TEACHER',
        name: '老師',
        description: 'Checkpoint B integration fixture role',
        is_system_reserved: true,
        status: role_status_e.ENABLED,
      },
      select: { id: true },
    });

    const createAccount = async (options: {
      suffix: string;
      status: user_status_e;
      emailVerified: boolean;
      assignRole: boolean;
    }) => {
      const account = await tx.user_account.create({
        data: {
          email: `${emailBase}-${options.suffix}@example.test`,
          email_verified: options.emailVerified,
          password_hash: passwordHash,
          name: 'M01 Integration Fixture',
          account_name: `m01-${suffix.slice(0, 15)}-${options.suffix}`,
          status: options.status,
        },
        select: { id: true, email: true },
      });
      if (options.assignRole) {
        await tx.user_role.create({
          data: { user_account_id: account.id, role_id: role.id },
        });
      }
      return account;
    };

    const active = await createAccount({
      suffix: 'active',
      status: user_status_e.ACTIVE,
      emailVerified: true,
      assignRole: true,
    });
    const disabled = await createAccount({
      suffix: 'disabled',
      status: user_status_e.DISABLED,
      emailVerified: true,
      assignRole: true,
    });
    const unverified = await createAccount({
      suffix: 'unverified',
      status: user_status_e.ACTIVE,
      emailVerified: false,
      assignRole: true,
    });
    const roleless = await createAccount({
      suffix: 'roleless',
      status: user_status_e.ACTIVE,
      emailVerified: true,
      assignRole: false,
    });
    return {
      roleId: role.id,
      accounts: { active, disabled, unverified, roleless },
      password,
    };
  });
}

async function removeFixture(
  prisma: PrismaService['client'],
  fixture: Fixture,
): Promise<void> {
  const ids = Object.values(fixture.accounts).map((account) => account.id);
  await prisma.$transaction(async (tx) => {
    await tx.login_session.deleteMany({
      where: { user_account_id: { in: ids } },
    });
    await tx.user_role.deleteMany({ where: { user_account_id: { in: ids } } });
    await tx.user_account.deleteMany({ where: { id: { in: ids } } });
    await tx.role.deleteMany({
      where: { id: fixture.roleId, role_code: 'TEACHER' },
    });
  });
}

function getCookie(setCookie: string[], name: string): string | undefined {
  const item = setCookie.find((cookie) => cookie.startsWith(`${name}=`));
  return item?.split(';', 1)[0].slice(name.length + 1);
}
