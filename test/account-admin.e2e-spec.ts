import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * US-F8 — admin account list/detail contract + disable/restore credential
 * invalidation lifecycle (DB-backed e2e).
 *
 * Covers: paginated list (metadata-only, no secrets), detail (incl. 404),
 * disable invalidating two Web sessions, atomic CLI key + unconsumed
 * validation-token revocation with domain rows preserved, restore not
 * resurrecting old credentials, disabled targets being refused new CLI keys,
 * and the disable-vs-confirmBatch race (no double-write).
 */
describe('Account admin & disable/restore lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'account-admin-e2e-admin',
    displayName: 'Account Admin E2E Admin',
    password: 'account-admin-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'account-admin-e2e-teacher',
    displayName: 'Account Admin E2E Teacher',
    tempPassword: 'account-admin-e2e-temp-password-1234',
    password: 'account-admin-e2e-final-password-1234',
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
      await prisma.prisma.$queryRaw`SELECT 1 FROM account LIMIT 0`;
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
    await truncateAll(prisma.prisma);
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

  /** Create a teacher account (admin) and log them in with a real password. */
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

  /** Admin re-verifies their password so step-up-protected ops succeed. */
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
        'BLOCKED: PostgreSQL migration/schema is unavailable for account-admin e2e tests.',
      );
    }
  }

  const BATCH_QUESTIONS = [
    {
      clientRef: 'q1',
      type: 'poll' as const,
      prompt: '批次題 1',
      selectionMode: 'single' as const,
      options: [
        { optionRef: 'a', text: 'A' },
        { optionRef: 'b', text: 'B' },
      ],
    },
  ];

  it('lists accounts as a paginated metadata-only Page<AccountDto>', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    await createTeacher();

    const res = await admin.agent.get('/api/v1/admin/accounts');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.meta.total).toBeGreaterThanOrEqual(2); // admin + teacher
    expect(data.data.length).toBeGreaterThanOrEqual(1);
    const row = data.data.find(
      (a: { username: string }) => a.username === TEACHER.username,
    );
    expect(row).toBeTruthy();
    expect(row.status).toBe('active');
    // No secrets in the projection.
    expect(JSON.stringify(res.body)).not.toContain('password');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('rawKey');
    expect(JSON.stringify(res.body)).not.toContain('token');
  });

  it('returns a single account detail and 404s for unknown/non-UUID ids', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacherId } = await createTeacher();

    const detail = await admin.agent.get(`/api/v1/admin/accounts/${teacherId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.id).toBe(teacherId);
    expect(detail.body.data.username).toBe(TEACHER.username);
    expect(detail.body.data.role).toBe('teacher');
    expect(JSON.stringify(detail.body)).not.toContain('password');

    const missing = await admin.agent.get(
      '/api/v1/admin/accounts/01900000-0000-7000-8000-000000000099',
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    const nonUuid = await admin.agent.get('/api/v1/admin/accounts/not-a-uuid');
    // Malformed ids are rejected by ParseUUIDPipe (400) before reaching the
    // service — a stable, existence-neutral error. Well-formed-but-missing ids
    // are 404. Either way the response never leaks account data.
    expect(nonUuid.status).toBe(400);
  });

  it('updates teacher course permission and enforces the server-side gate', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacher, teacherId } = await createTeacher();

    const disabled = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}/permissions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ canCreateCourse: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.canCreateCourse).toBe(false);
    expect(disabled.body.data.status).toBe('active');

    const beforeReenable = await prisma.prisma.course.count({
      where: { ownerAccountId: teacherId },
    });
    const blockedCourse = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'F16 blocked course' });
    expect(blockedCourse.status).toBe(403);
    expect(blockedCourse.body.error.code).toBe('FORBIDDEN');
    expect(
      await prisma.prisma.course.count({
        where: { ownerAccountId: teacherId },
      }),
    ).toBe(beforeReenable);

    const enabled = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}/permissions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ canCreateCourse: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.data.canCreateCourse).toBe(true);

    const createdCourse = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'F16 enabled course' });
    expect(createdCourse.status).toBe(201);
    expect(createdCourse.body.data.ownerAccountId).toBe(teacherId);
  });

  it('keeps permission updates separate from student authorization and validates the contract', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacher, teacherId } = await createTeacher();

    const nonAdmin = await teacher.agent
      .patch(`/api/v1/admin/accounts/${teacherId}/permissions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ canCreateCourse: false });
    expect(nonAdmin.status).toBe(403);
    expect(nonAdmin.body.error.code).toBe('FORBIDDEN');

    const invalidBody = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}/permissions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ canCreateCourse: 'true' });
    expect(invalidBody.status).toBe(400);
    expect(invalidBody.body.error.code).toBe('VALIDATION_FAILED');

    const unknownField = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}/permissions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ canCreateCourse: true, status: 'disabled' });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error.code).toBe('VALIDATION_FAILED');

    const missing = await admin.agent
      .patch(
        '/api/v1/admin/accounts/01900000-0000-7000-8000-000000000099/permissions',
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ canCreateCourse: false });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    const malformed = await admin.agent
      .patch('/api/v1/admin/accounts/not-a-uuid/permissions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ canCreateCourse: false });
    expect(malformed.status).toBe(400);

    const createdStudent = await admin.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        username: 'account-admin-f16-student',
        displayName: 'Account Admin F16 Student',
        role: AccountRole.STUDENT,
        canCreateCourse: true,
        tempPassword: 'account-admin-f16-student-password-1234',
      });
    expect(createdStudent.status).toBe(201);
    expect(createdStudent.body.data.canCreateCourse).toBe(false);

    const studentGrant = await admin.agent
      .patch(
        `/api/v1/admin/accounts/${createdStudent.body.data.id}/permissions`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ canCreateCourse: true });
    expect(studentGrant.status).toBe(403);
    expect(studentGrant.body.error.code).toBe('FORBIDDEN');

    const studentNoOp = await admin.agent
      .patch(
        `/api/v1/admin/accounts/${createdStudent.body.data.id}/permissions`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ canCreateCourse: false });
    expect(studentNoOp.status).toBe(200);
    expect(studentNoOp.body.data.canCreateCourse).toBe(false);
  });

  it('requires CSRF for permission updates', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacherId } = await createTeacher();

    const res = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}/permissions`)
      .set('Origin', TEST_ORIGIN)
      .send({ canCreateCourse: false });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_CSRF_INVALID');
  });

  it('requires admin for the list route', async () => {
    requireDatabase();
    const { teacher } = await createTeacher();
    const res = await teacher.agent.get('/api/v1/admin/accounts');
    expect(res.status).toBe(403);
  });

  it('disable invalidates every existing Web session', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacherId } = await createTeacher();

    // Two independent sessions for the same teacher.
    const sessionA = await loginAs(TEACHER.username, TEACHER.password);
    const sessionB = await loginAs(TEACHER.username, TEACHER.password);
    expect((await sessionA.agent.get('/api/v1/auth/session')).status).toBe(200);
    expect((await sessionB.agent.get('/api/v1/auth/session')).status).toBe(200);

    await adminStepUp(admin);
    const disable = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/disable`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(disable.status).toBe(201);
    expect(disable.body.data.status).toBe('disabled');

    // Both pre-existing sessions are immediately invalid.
    expect((await sessionA.agent.get('/api/v1/auth/session')).status).toBe(401);
    expect((await sessionB.agent.get('/api/v1/auth/session')).status).toBe(401);

    // A guarded mutation via the disabled session is rejected too.
    const guarded = await sessionA.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, sessionA.csrfToken)
      .send({ name: 'Should Fail' });
    expect(guarded.status).toBe(401);
  });

  it('disable atomically revokes CLI keys + unconsumed tokens; restore does not resurrect them', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacher, teacherId } = await createTeacher();

    await adminStepUp(admin);
    const cli = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name: 'f8-key' });
    expect(cli.status).toBe(201);
    const rawKey = cli.body.data.rawKey as string;

    const course = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'F8 Course' });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;

    const validate = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ schemaVersion: 1, courseId, questions: BATCH_QUESTIONS });
    expect(validate.status).toBe(201);

    // CLI auth still works before disable.
    const preCli = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', rawKey)
      .send({ schemaVersion: 1, courseId, questions: [] });
    expect(preCli.status).toBe(201);

    await adminStepUp(admin);
    const disable = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/disable`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(disable.status).toBe(201);

    // CLI key revoked.
    const cliAfter = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', rawKey)
      .send({ schemaVersion: 1, courseId, questions: [] });
    expect(cliAfter.status).toBe(401);
    expect(cliAfter.body.error.code).toBe('CLI_CREDENTIAL_REVOKED');

    // Unconsumed validation token is atomically invalidated (consumedAt set)
    // by disable. The actor's own session/CLI are revoked too, so the honest
    // assertion for "token unusable" is the DB row, not an HTTP 409.
    const unconsumed = await prisma.prisma.questionValidationToken.count({
      where: { accountId: teacherId, consumedAt: null },
    });
    expect(unconsumed).toBe(0);

    // Domain rows preserved — no hard delete.
    const courseRows = await prisma.prisma.course.count({
      where: { id: courseId },
    });
    expect(courseRows).toBe(1);
    const questionRows = await prisma.prisma.questionDefinition.count({
      where: { courseId },
    });
    expect(questionRows).toBe(0); // confirm never committed

    // Restore: Web login works again, but old credential never resurrects.
    await adminStepUp(admin);
    const restore = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/restore`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(restore.status).toBe(201);
    expect(restore.body.data.status).toBe('active');

    const freshLogin = await loginAs(TEACHER.username, TEACHER.password);
    expect((await freshLogin.agent.get('/api/v1/auth/session')).status).toBe(
      200,
    );

    const cliAfterRestore = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', rawKey)
      .send({ schemaVersion: 1, courseId, questions: [] });
    expect(cliAfterRestore.status).toBe(401);
    expect(cliAfterRestore.body.error.code).toBe('CLI_CREDENTIAL_REVOKED');
  });

  it('rejects issuing a new CLI key to a disabled account', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacherId } = await createTeacher();

    await adminStepUp(admin);
    const disable = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/disable`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(disable.status).toBe(201);

    await adminStepUp(admin);
    const issue = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name: 'should-be-refused' });
    expect(issue.status).toBe(403);
    expect(issue.body.error.code).toBe('FORBIDDEN');
  });

  it('serializes disable vs confirmBatch: no double-write, consistent domain', async () => {
    requireDatabase();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { teacher, teacherId } = await createTeacher();

    const course = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Race Course' });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;

    const validate = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ schemaVersion: 1, courseId, questions: BATCH_QUESTIONS });
    expect(validate.status).toBe(201);
    const payloadHash = validate.body.data.payloadHash as string;
    const validationToken = validate.body.data.validationToken as string;

    await adminStepUp(admin);

    const disableReq = admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/disable`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    const confirmReq = teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/confirm`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .set('Idempotency-Key', '01900000-0000-7000-8000-000000000202')
      .set('X-Validation-Token', validationToken)
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash,
        confirmed: true,
      });

    const [disableRes, confirmRes] = await Promise.all([
      disableReq,
      confirmReq,
    ]);

    // Whichever won, disable reports 201 and domain state is consistent: the
    // question is written exactly once (or never), never duplicated.
    expect(disableRes.status).toBe(201);
    const questionCount = await prisma.prisma.questionDefinition.count({
      where: { courseId },
    });
    expect(questionCount).toBeLessThanOrEqual(1);

    if (questionCount === 1) {
      // Confirm won: both 2xx, token consumed before disable.
      expect(confirmRes.status).toBe(201);
    } else {
      // Disable won: the confirm is refused. If disable committed before the
      // confirm transaction read the account, the in-tx re-check throws 403
      // FORBIDDEN; if the confirm's session was revoked first (or the token
      // invalidated), the request is rejected earlier with 401/403/409. The
      // invariant is: no question written, domain consistent.
      expect([401, 403, 409]).toContain(confirmRes.status);
    }
  });
});
