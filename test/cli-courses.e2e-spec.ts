import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { hashToken, newId } from '../src/common/crypto';
import { CSRF_HEADER } from '../src/common/security';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * E2E coverage for the shared Web-or-CLI Course collection routes.
 *
 * This suite is intentionally DB-backed. Raw CLI keys stay in process memory;
 * they are never logged or persisted by the fixture helpers.
 */
describe('CLI courses (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'cli-courses-admin',
    displayName: 'CLI Courses Admin',
    password: 'cli-courses-admin-password-1234',
  };
  const TEACHER = {
    username: 'cli-courses-teacher',
    displayName: 'CLI Courses Teacher',
    tempPassword: 'cli-courses-temp-password-1234',
    password: 'cli-courses-final-password-1234',
  };

  type Agent = {
    agent: request.SuperAgentTest;
    csrf: string;
  };

  beforeAll(async () => {
    try {
      setupTestDb();
      migrationsReady = true;
    } catch {
      // requireDatabase() reports the blocked DB-backed suite below.
    }

    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);

    if (!migrationsReady) return;
    try {
      await prisma.prisma.$queryRaw`SELECT 1 FROM cli_credential LIMIT 0`;
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    await withQuiescedLiveSessionPublisher(app, () =>
      truncateAll(prisma.prisma),
    );
    await bootstrap.createFirstAdmin(ADMIN);
  });

  function cookieValue(setCookie: string[] | undefined, name: string): string {
    const prefix = `${name}=`;
    const value = setCookie
      ?.find((cookie) => cookie.startsWith(prefix))
      ?.split(';', 1)[0]
      .slice(prefix.length);
    if (!value) throw new Error(`Missing ${name} cookie`);
    return value;
  }

  async function login(username: string, password: string): Promise<Agent> {
    const agent = request.agent(app.getHttpServer());
    const response = await agent
      .post('/api/v1/auth/login')
      .send({ username, password });
    expect(response.status).toBe(201);
    return {
      agent: agent as unknown as request.SuperAgentTest,
      csrf: cookieValue(
        response.headers['set-cookie'] as unknown as string[] | undefined,
        '__Host-csrf',
      ),
    };
  }

  async function createTeacher(admin: Agent): Promise<{
    id: string;
    agent: Agent;
  }> {
    const created = await admin.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({
        username: TEACHER.username,
        displayName: TEACHER.displayName,
        role: AccountRole.TEACHER,
        canCreateCourse: true,
        tempPassword: TEACHER.tempPassword,
      });
    expect(created.status).toBe(201);

    const temporary = await login(TEACHER.username, TEACHER.tempPassword);
    const changed = await temporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, temporary.csrf)
      .send({
        currentPassword: TEACHER.tempPassword,
        newPassword: TEACHER.password,
      });
    expect(changed.status).toBe(201);

    return {
      id: created.body.data.id as string,
      agent: await login(TEACHER.username, TEACHER.password),
    };
  }

  async function issueCliKey(
    admin: Agent,
    accountId: string,
    name: string,
  ): Promise<{ id: string; rawKey: string }> {
    const stepUp = await admin.agent
      .post('/api/v1/auth/step-up')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ password: ADMIN.password });
    expect(stepUp.status).toBe(201);

    const created = await admin.agent
      .post(`/api/v1/admin/accounts/${accountId}/cli-credentials`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ name });
    expect(created.status).toBe(201);
    expect(created.body.data.rawKey).toBeTruthy();
    return {
      id: created.body.data.id as string,
      rawKey: created.body.data.rawKey as string,
    };
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for CLI courses e2e tests.',
      );
    }
  }

  async function createCourseRow(input: {
    ownerAccountId: string;
    name: string;
    status?: 'draft' | 'archived';
    createdAt: string;
  }): Promise<string> {
    const id = newId();
    const createdAt = new Date(input.createdAt);
    await prisma.prisma.course.create({
      data: {
        id,
        ownerAccountId: input.ownerAccountId,
        name: input.name,
        description: `${input.name} description`,
        status: input.status ?? 'draft',
        createdAt,
        updatedAt: createdAt,
      },
    });
    return id;
  }

  it('creates a draft owned by the CLI account with a narrow response and no CSRF', async () => {
    requireDatabase();
    const admin = await login(ADMIN.username, ADMIN.password);
    const teacher = await createTeacher(admin);
    const { rawKey } = await issueCliKey(admin, teacher.id, 'course-create');

    const response = await request(app.getHttpServer())
      .post('/api/v1/courses')
      .set('X-CLI-Key', rawKey)
      .send({
        name: 'CLI Created Course',
        description: 'Created without a browser session.',
      });

    expect(response.status).toBe(201);
    expect(Object.keys(response.body.data).sort()).toEqual(
      ['id', 'name', 'status'].sort(),
    );
    expect(response.body.data.name).toBe('CLI Created Course');
    expect(response.body.data.status).toBe('draft');
    expect(response.body.data.description).toBeUndefined();
    expect(response.body.data.ownerAccountId).toBeUndefined();

    const row = await prisma.prisma.course.findUnique({
      where: { id: response.body.data.id as string },
    });
    expect(row).toMatchObject({
      id: response.body.data.id,
      ownerAccountId: teacher.id,
      name: 'CLI Created Course',
      description: 'Created without a browser session.',
      status: 'draft',
    });
    expect(JSON.stringify(response.body)).not.toContain(hashToken(rawKey));
  });

  it('lists only the CLI owner drafts with narrow fields and accurate pagination', async () => {
    requireDatabase();
    const admin = await login(ADMIN.username, ADMIN.password);
    const teacher = await createTeacher(admin);
    const { rawKey } = await issueCliKey(admin, teacher.id, 'course-list');

    await createCourseRow({
      ownerAccountId: teacher.id,
      name: 'Owner Old Draft',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await createCourseRow({
      ownerAccountId: teacher.id,
      name: 'Owner Middle Draft',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    await createCourseRow({
      ownerAccountId: teacher.id,
      name: 'Owner New Draft',
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    await createCourseRow({
      ownerAccountId: teacher.id,
      name: 'Owner Archived',
      status: 'archived',
      createdAt: '2026-01-04T00:00:00.000Z',
    });
    await createCourseRow({
      ownerAccountId: (
        await prisma.prisma.account.findUniqueOrThrow({
          where: { username: ADMIN.username },
        })
      ).id,
      name: 'Other Owner Draft',
      createdAt: '2026-01-05T00:00:00.000Z',
    });

    const pageOne = await request(app.getHttpServer())
      .get('/api/v1/courses')
      .query({ page: 1, pageSize: 2 })
      .set('X-CLI-Key', rawKey);
    expect(pageOne.status).toBe(200);
    expect(pageOne.body.data.meta).toEqual({
      page: 1,
      pageSize: 2,
      total: 3,
      totalPages: 2,
    });
    expect(
      pageOne.body.data.data.map((course: { name: string }) => course.name),
    ).toEqual(['Owner New Draft', 'Owner Middle Draft']);
    for (const course of pageOne.body.data.data) {
      expect(Object.keys(course).sort()).toEqual(
        ['id', 'name', 'status'].sort(),
      );
      expect(course.status).toBe('draft');
    }

    const pageTwo = await request(app.getHttpServer())
      .get('/api/v1/courses')
      .query({ page: 2, pageSize: 2 })
      .set('X-CLI-Key', rawKey);
    expect(pageTwo.status).toBe(200);
    expect(pageTwo.body.data.meta).toEqual({
      page: 2,
      pageSize: 2,
      total: 3,
      totalPages: 2,
    });
    expect(
      pageTwo.body.data.data.map((course: { name: string }) => course.name),
    ).toEqual(['Owner Old Draft']);
    const serialized = JSON.stringify(
      pageOne.body.data.data.concat(pageTwo.body.data.data),
    );
    expect(serialized).not.toContain('Owner Archived');
    expect(serialized).not.toContain('Other Owner Draft');
    expect(serialized).not.toContain('description');
    expect(serialized).not.toContain(teacher.id);
  });

  it('keeps CLI listing available after canCreateCourse is disabled but rejects create', async () => {
    requireDatabase();
    const admin = await login(ADMIN.username, ADMIN.password);
    const teacher = await createTeacher(admin);
    const { id: credentialId, rawKey } = await issueCliKey(
      admin,
      teacher.id,
      'permission-independent',
    );
    const courseId = await createCourseRow({
      ownerAccountId: teacher.id,
      name: 'Still Listable Draft',
      createdAt: '2026-02-01T00:00:00.000Z',
    });

    const permission = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacher.id}/permissions`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ canCreateCourse: false });
    expect(permission.status).toBe(200);

    const list = await request(app.getHttpServer())
      .get('/api/v1/courses')
      .set('X-CLI-Key', rawKey);
    expect(list.status).toBe(200);
    expect(list.body.data.data).toEqual([
      { id: courseId, name: 'Still Listable Draft', status: 'draft' },
    ]);

    const create = await request(app.getHttpServer())
      .post('/api/v1/courses')
      .set('X-CLI-Key', rawKey)
      .send({ name: 'Must Not Be Created' });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('FORBIDDEN');

    const credential = await prisma.prisma.cliCredential.findUnique({
      where: { id: credentialId },
    });
    expect(credential).toMatchObject({
      id: credentialId,
      accountId: teacher.id,
      status: 'active',
    });
  });

  it('does not fall back to a valid Web cookie when X-CLI-Key is invalid', async () => {
    requireDatabase();
    const admin = await login(ADMIN.username, ADMIN.password);
    const teacher = await createTeacher(admin);
    const response = await teacher.agent.agent
      .get('/api/v1/courses')
      .set('X-CLI-Key', 'definitely-not-a-valid-cli-key');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CLI_CREDENTIAL_INVALID');
  });

  it('preserves the Web create/list contract while sharing the collection routes', async () => {
    requireDatabase();
    const admin = await login(ADMIN.username, ADMIN.password);
    const teacher = await createTeacher(admin);

    const missingCsrf = await teacher.agent.agent
      .post('/api/v1/courses')
      .set('Origin', ORIGIN)
      .send({ name: 'Web CSRF Required' });
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.error.code).toBe('AUTH_CSRF_INVALID');

    const created = await teacher.agent.agent
      .post('/api/v1/courses')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, teacher.agent.csrf)
      .send({ name: 'Web Full Course', description: 'Web description' });
    expect(created.status).toBe(201);
    expect(Object.keys(created.body.data).sort()).toEqual(
      [
        'id',
        'name',
        'description',
        'status',
        'ownerAccountId',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(created.body.data).toMatchObject({
      name: 'Web Full Course',
      description: 'Web description',
      status: 'draft',
      ownerAccountId: teacher.id,
    });

    const archived = await teacher.agent.agent
      .post(`/api/v1/courses/${created.body.data.id}/archive`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, teacher.agent.csrf);
    expect(archived.status).toBe(201);
    expect(archived.body.data.status).toBe('archived');

    const list = await teacher.agent.agent.get('/api/v1/courses');
    expect(list.status).toBe(200);
    expect(list.body.data.meta).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    });
    expect(list.body.data.data).toEqual([
      expect.objectContaining({
        id: created.body.data.id,
        name: 'Web Full Course',
        description: 'Web description',
        status: 'archived',
        ownerAccountId: teacher.id,
      }),
    ]);
  });
});
