import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashToken } from '../src/common/crypto';
import { CSRF_HEADER } from '../src/common/security';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('CLI credential (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'cli-e2e-admin',
    displayName: 'CLI E2E Admin',
    password: 'cli-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'cli-e2e-teacher',
    displayName: 'CLI E2E Teacher',
    tempPassword: 'cli-e2e-temp-password-1234',
    password: 'cli-e2e-final-password-1234',
  };

  type AuthenticatedAgent = {
    agent: request.SuperAgentTest;
    csrfToken: string;
  };

  beforeAll(async () => {
    try {
      setupTestDb();
      migrationsReady = true;
    } catch {
      // blocked
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

  function cookieHeaders(value: string | string[] | undefined): string[] {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  }

  function cookieValue(setCookie: string[] | undefined, name: string): string {
    const prefix = `${name}=`;
    const value = setCookie
      ?.find((cookie) => cookie.startsWith(prefix))
      ?.split(';', 1)[0]
      .slice(prefix.length);
    if (!value) throw new Error(`Missing ${name} cookie`);
    return value;
  }

  async function loginAs(
    username: string,
    password: string,
  ): Promise<AuthenticatedAgent> {
    const agent = request.agent(app.getHttpServer());
    const response = await agent
      .post('/api/v1/auth/login')
      .send({ username, password });
    const setCookie = cookieHeaders(response.headers['set-cookie']);
    return {
      agent: agent as unknown as request.SuperAgentTest,
      csrfToken: cookieValue(setCookie, '__Host-csrf'),
    };
  }

  async function createTeacher(): Promise<{
    teacher: AuthenticatedAgent;
    teacherId: string;
  }> {
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const created = await admin.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        username: TEACHER.username,
        displayName: TEACHER.displayName,
        role: AccountRole.TEACHER,
        canCreateCourse: true,
        tempPassword: TEACHER.tempPassword,
      });
    expect(created.status).toBe(201);
    const teacherId = created.body.data.id as string;

    const temporary = await loginAs(TEACHER.username, TEACHER.tempPassword);
    const changed = await temporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, temporary.csrfToken)
      .send({
        currentPassword: TEACHER.tempPassword,
        newPassword: TEACHER.password,
      });
    expect(changed.status).toBe(201);
    return {
      teacher: await loginAs(TEACHER.username, TEACHER.password),
      teacherId,
    };
  }

  /** Admin steps up (re-verifies password) so subsequent step-up-protected
   * operations succeed within the 10-minute window. */
  async function adminStepUp(admin: AuthenticatedAgent): Promise<void> {
    const res = await admin.agent
      .post('/api/v1/auth/step-up')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ password: ADMIN.password });
    expect(res.status).toBe(201);
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for CLI credential e2e tests.',
      );
    }
  }

  it('admin creates a CLI credential (step-up) and returns the raw key once', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacherId } = await createTeacher();
    await adminStepUp(admin);

    const res = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name: 'my-key' });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.name).toBe('my-key');
    expect(res.body.data.scope).toBe('all_courses');
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.rawKey).toBeTruthy();
    const rawKey = res.body.data.rawKey as string;
    // Raw key never returned again by list.
    const list = await admin.agent.get(
      `/api/v1/admin/accounts/${teacherId}/cli-credentials`,
    );
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].rawKey).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain(rawKey);
  });

  it('rejects CLI credential creation without step-up', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacherId } = await createTeacher();

    const res = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name: 'no-stepup' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_STEP_UP_REQUIRED');
  });

  it('authenticates a CLI actor via X-CLI-Key on a CLI-guarded route', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacher, teacherId } = await createTeacher();
    await adminStepUp(admin);
    const created = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name: 'cli-actor' });
    const rawKey = created.body.data.rawKey as string;

    // Use the CLI key to hit the batch validate endpoint (CLI-guarded). It will
    // return 400 for an empty/invalid batch body, but 401/403 if auth fails.
    // We assert the CLI key is accepted (not 401) by sending a valid-shape body
    // against a draft course the teacher owns.
    const course = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'CLI Course' });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;

    const validate = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', rawKey)
      .send({
        schemaVersion: 1,
        courseId,
        // 51 questions exceeds the batch max (50). validate returns the result
        // as a successful HTTP response (201) with valid=false + errors,
        // proving the CLI key authenticated (401/403 would mean auth failed).
        questions: Array.from({ length: 51 }, (_, i) => ({
          clientRef: `q${i}`,
          type: 'open_text',
          prompt: `p${i}`,
        })),
      });
    expect(validate.status).toBe(201);
    expect(validate.body.data.valid).toBe(false);
    expect(
      validate.body.data.errors.some(
        (e: { code: string }) => e.code === 'BATCH_SIZE_INVALID',
      ),
    ).toBe(true);
    expect(JSON.stringify(validate.body)).not.toContain(rawKey);
  });

  it('rejects a revoked CLI key', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacherId } = await createTeacher();
    await adminStepUp(admin);
    const created = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name: 'revoke-me' });
    const rawKey = created.body.data.rawKey as string;
    const credentialId = created.body.data.id as string;

    const revoke = await admin.agent
      .post(
        `/api/v1/admin/accounts/${teacherId}/cli-credentials/${credentialId}/revoke`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(revoke.status).toBe(200);

    const course = await prisma.prisma.course.create({
      data: {
        id: '01900000-0000-7000-8000-000000000001',
        ownerAccountId: teacherId,
        name: 'Rev Course',
        status: 'draft',
      },
    });
    const validate = await request(app.getHttpServer())
      .post(`/api/v1/courses/${course.id}/question-batches/validate`)
      .set('X-CLI-Key', rawKey)
      .send({ schemaVersion: 1, questions: [] });
    expect(validate.status).toBe(401);
    expect(validate.body.error.code).toBe('CLI_CREDENTIAL_REVOKED');
  });

  it('rejects a CLI key whose account is disabled', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacherId } = await createTeacher();
    await adminStepUp(admin);
    const created = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name: 'disable-me' });
    const rawKey = created.body.data.rawKey as string;

    // Disable the teacher account (step-up already done above).
    const disable = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/disable`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(disable.status).toBe(201);

    const course = await prisma.prisma.course.create({
      data: {
        id: '01900000-0000-7000-8000-000000000002',
        ownerAccountId: teacherId,
        name: 'Dis Course',
        status: 'draft',
      },
    });
    const validate = await request(app.getHttpServer())
      .post(`/api/v1/courses/${course.id}/question-batches/validate`)
      .set('X-CLI-Key', rawKey)
      .send({ schemaVersion: 1, questions: [] });
    expect(validate.status).toBe(401);
    // Account disable revokes CLI credentials (M2 red-card), so the key is revoked.
    expect(validate.body.error.code).toBe('CLI_CREDENTIAL_REVOKED');
  });

  it('rotates a CLI credential atomically and immediately invalidates the predecessor', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacher, teacherId } = await createTeacher();
    await adminStepUp(admin);
    const created = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name: 'rotate-me' });
    expect(created.status).toBe(201);
    const predecessorId = created.body.data.id as string;
    const predecessorKey = created.body.data.rawKey as string;
    const course = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Rotation Course' });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;

    const before = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', predecessorKey)
      .send({
        schemaVersion: 1,
        questions: Array.from({ length: 51 }, (_, i) => ({
          clientRef: `before-${i}`,
          type: 'open_text',
          prompt: `before-${i}`,
        })),
      });
    expect(before.status).toBe(201);
    expect(before.body.data.valid).toBe(false);

    const rotated = await admin.agent
      .post(
        `/api/v1/admin/accounts/${teacherId}/cli-credentials/${predecessorId}/rotate`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(rotated.status).toBe(201);
    expect(rotated.body.data.rawKey).toBeTruthy();
    const successorKey = rotated.body.data.rawKey as string;
    const successorId = rotated.body.data.id as string;
    expect(successorId).not.toBe(predecessorId);
    expect(rotated.body.data.name).toBe('rotate-me');
    expect(rotated.body.data.scope).toBe('all_courses');
    expect(rotated.body.data.status).toBe('active');
    expect(rotated.body.data.rotatedFromId).toBe(predecessorId);
    expect(JSON.stringify(rotated.body)).not.toContain(
      hashToken(predecessorKey),
    );

    const oldKey = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', predecessorKey)
      .send({ schemaVersion: 1, questions: [] });
    expect(oldKey.status).toBe(401);
    expect(oldKey.body.error.code).toBe('CLI_CREDENTIAL_REVOKED');

    const successor = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', successorKey)
      .send({ schemaVersion: 1, questions: [] });
    expect(successor.status).toBe(201);
    expect(successor.body.data.valid).toBe(false);

    const permission = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}/permissions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ canCreateCourse: false });
    expect(permission.status).toBe(200);
    const successorAfterPermissionChange = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', successorKey)
      .send({ schemaVersion: 1, questions: [] });
    expect(successorAfterPermissionChange.status).toBe(201);

    const predecessorRow = await prisma.prisma.cliCredential.findUnique({
      where: { id: predecessorId },
    });
    const successorRow = await prisma.prisma.cliCredential.findUnique({
      where: { id: successorId },
    });
    expect(predecessorRow).toMatchObject({
      id: predecessorId,
      accountId: teacherId,
      status: 'revoked',
      name: expect.stringContaining('~rotated~'),
    });
    expect(predecessorRow?.name.length).toBeLessThanOrEqual(63);
    expect(successorRow).toMatchObject({
      id: successorId,
      accountId: teacherId,
      name: 'rotate-me',
      scope: 'all_courses',
      status: 'active',
      rotatedFromId: predecessorId,
      keyHash: hashToken(successorKey),
    });
    const list = await admin.agent.get(
      `/api/v1/admin/accounts/${teacherId}/cli-credentials`,
    );
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toContain(successorKey);
    expect(JSON.stringify(list.body)).not.toContain(hashToken(successorKey));
  });

  it('supports multi-generation lineage and rejects repeated concurrent rotation', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacherId } = await createTeacher();
    await adminStepUp(admin);
    const created = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name: 'lineage' });
    const firstId = created.body.data.id as string;

    const second = await admin.agent
      .post(
        `/api/v1/admin/accounts/${teacherId}/cli-credentials/${firstId}/rotate`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(second.status).toBe(201);
    const secondId = second.body.data.id as string;

    const third = await admin.agent
      .post(
        `/api/v1/admin/accounts/${teacherId}/cli-credentials/${secondId}/rotate`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(third.status).toBe(201);
    const thirdId = third.body.data.id as string;

    const [repeatOne, repeatTwo] = await Promise.all([
      admin.agent
        .post(
          `/api/v1/admin/accounts/${teacherId}/cli-credentials/${thirdId}/rotate`,
        )
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, admin.csrfToken),
      admin.agent
        .post(
          `/api/v1/admin/accounts/${teacherId}/cli-credentials/${thirdId}/rotate`,
        )
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, admin.csrfToken),
    ]);
    expect([repeatOne.status, repeatTwo.status].sort()).toEqual([201, 409]);
    const fourth = [repeatOne, repeatTwo].find((res) => res.status === 201);
    expect(fourth?.body.data.rawKey).toBeTruthy();

    const rows = await prisma.prisma.cliCredential.findMany({
      where: { accountId: teacherId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.rotatedFromId)).toEqual([
      null,
      firstId,
      secondId,
      thirdId,
    ]);
    expect(rows.filter((row) => row.rotatedFromId === thirdId)).toHaveLength(1);
  });

  it('serializes rotate versus disable without leaving an active credential', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacherId } = await createTeacher();
    await adminStepUp(admin);
    const created = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name: 'disable-race' });
    const credentialId = created.body.data.id as string;

    const [rotate, disable] = await Promise.all([
      admin.agent
        .post(
          `/api/v1/admin/accounts/${teacherId}/cli-credentials/${credentialId}/rotate`,
        )
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, admin.csrfToken),
      admin.agent
        .post(`/api/v1/admin/accounts/${teacherId}/disable`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, admin.csrfToken),
    ]);
    expect([rotate.status, disable.status].sort()).toEqual([201, 201]);

    const account = await prisma.prisma.account.findUnique({
      where: { id: teacherId },
    });
    const credentials = await prisma.prisma.cliCredential.findMany({
      where: { accountId: teacherId },
    });
    expect(account?.status).toBe('disabled');
    expect(
      credentials.filter((credential) => credential.status === 'active'),
    ).toHaveLength(0);

    const restored = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/restore`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(restored.status).toBe(201);
    const afterRestore = await prisma.prisma.cliCredential.findMany({
      where: { accountId: teacherId, status: 'active' },
    });
    expect(afterRestore).toHaveLength(0);
  });

  it('requires step-up, CSRF, admin authorization, and valid UUIDs for rotation', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacher, teacherId } = await createTeacher();
    await adminStepUp(admin);
    const created = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name: 'guarded-rotate' });
    const credentialId = created.body.data.id as string;
    const freshAdmin = await loginAs(ADMIN.username, ADMIN.password);

    const noStepUp = await freshAdmin.agent.post(
      `/api/v1/admin/accounts/${teacherId}/cli-credentials/${credentialId}/rotate`,
    );
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body.error.code).toBe('AUTH_CSRF_INVALID');

    const noStepUpWithCsrf = await freshAdmin.agent
      .post(
        `/api/v1/admin/accounts/${teacherId}/cli-credentials/${credentialId}/rotate`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, freshAdmin.csrfToken);
    expect(noStepUpWithCsrf.status).toBe(403);
    expect(noStepUpWithCsrf.body.error.code).toBe('AUTH_STEP_UP_REQUIRED');

    const teacherAttempt = await teacher.agent
      .post(
        `/api/v1/admin/accounts/${teacherId}/cli-credentials/${credentialId}/rotate`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(teacherAttempt.status).toBe(403);

    await adminStepUp(admin);
    const malformed = await admin.agent
      .post(
        `/api/v1/admin/accounts/not-a-uuid/cli-credentials/${credentialId}/rotate`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(malformed.status).toBe(400);
  });

  it('rejects a missing CLI key with 401', async () => {
    requireDatabase();
    const { teacher } = await createTeacher();
    const course = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'NoKey Course' });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;

    // No X-CLI-Key and no cookie → BatchActorGuard delegates to SessionGuard,
    // which rejects with 401. The course is never touched.
    const validate = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .send({ schemaVersion: 1, questions: [] });
    expect(validate.status).toBe(401);
  });
});
