import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CSRF_COOKIE_NAME, CSRF_HEADER } from '../src/common/security';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * FE-4.1 — student-only lifecycle receipt.
 *
 * GET /api/v1/live-sessions/:liveSessionId/student-status returns an exact
 * {id,status,startedAt,closedAt} allowlist for every lifecycle state, including
 * terminal closed/cancelled sessions. It must never read or create a
 * Participant and must reject teacher/admin, anonymous, and participant-token
 * callers.
 */
describe('Student session status (FE-4.1 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'student-status-e2e-admin',
    displayName: 'Student Status E2E Admin',
    password: 'student-status-e2e-admin-1234',
  };
  const TEACHER = {
    username: 'student-status-e2e-teacher',
    displayName: 'Student Status E2E Teacher',
    tempPassword: 'student-status-e2e-teacher-temp-1234',
    password: 'student-status-e2e-teacher-final-1234',
  };
  const STUDENT = {
    username: 'student-status-e2e-student',
    displayName: 'Student Status E2E Student',
    tempPassword: 'student-status-e2e-student-temp-1234',
    password: 'student-status-e2e-student-final-1234',
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
      // Keep the suite blocked when migration setup fails.
    }
    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);
    if (!migrationsReady) return;
    try {
      await prisma.prisma.$queryRaw`SELECT 1`;
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
    expect(response.status).toBe(201);
    return {
      agent: agent as unknown as request.SuperAgentTest,
      csrfToken: cookieValue(
        cookieHeaders(response.headers['set-cookie']),
        CSRF_COOKIE_NAME,
      ),
    };
  }

  async function provisionAndLogin(
    admin: AuthenticatedAgent,
    account: {
      username: string;
      displayName: string;
      tempPassword: string;
      password: string;
      role: AccountRole;
    },
  ): Promise<{ accountId: string; auth: AuthenticatedAgent }> {
    const created = await admin.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        username: account.username,
        displayName: account.displayName,
        role: account.role,
        canCreateCourse: account.role === AccountRole.TEACHER,
        tempPassword: account.tempPassword,
      });
    expect(created.status).toBe(201);

    const temporary = await loginAs(account.username, account.tempPassword);
    const changed = await temporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, temporary.csrfToken)
      .send({
        currentPassword: account.tempPassword,
        newPassword: account.password,
      });
    expect(changed.status).toBe(201);

    return {
      accountId: created.body.data.id as string,
      auth: await loginAs(account.username, account.password),
    };
  }

  /**
   * Create a draft course with one poll question and a waiting LiveSession,
   * then start it (active). Returns the ids needed by later requests.
   */
  async function setupActiveSession(
    teacher: AuthenticatedAgent,
    courseName: string,
  ): Promise<{
    courseId: string;
    liveSessionId: string;
    sessionCode: string;
    sessionQuestionId: string;
  }> {
    const course = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: courseName });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;

    const question = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: 'Which option?',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(question.status).toBe(201);

    const waiting = await teacher.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ courseId, questionIds: [question.body.data.id] });
    expect(waiting.status).toBe(201);
    const liveSessionId = waiting.body.data.id as string;
    const sessionCode = waiting.body.data.sessionCode as string;

    const started = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/start`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(started.status).toBe(201);

    return {
      courseId,
      liveSessionId,
      sessionCode,
      sessionQuestionId: started.body.data.sessionQuestions[0].id as string,
    };
  }

  async function enrollStudent(
    teacher: AuthenticatedAgent,
    courseId: string,
    studentAccountId: string,
  ): Promise<void> {
    const enrolled = await teacher.agent
      .post(`/api/v1/courses/${courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ studentAccountId });
    expect(enrolled.status).toBe(201);
  }

  function expectExactReceipt(
    body: Record<string, unknown>,
    expected: {
      id: string;
      status: string;
      startedAt: string | null;
      closedAt: string | null;
    },
  ): void {
    expect(Object.keys(body).sort()).toEqual([
      'closedAt',
      'id',
      'startedAt',
      'status',
    ]);
    expect(body).toEqual(expected);
  }

  it('returns the active receipt for an enrolled student without a participant row', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(
      teacher.auth,
      'Student Status Active Course',
    );
    await enrollStudent(teacher.auth, session.courseId, student.accountId);

    const response = await student.auth.agent
      .get(`/api/v1/live-sessions/${session.liveSessionId}/student-status`)
      .set('X-Participant-Token', 'ignored-bearer-value');
    expect(response.status).toBe(200);
    expectExactReceipt(response.body.data as Record<string, unknown>, {
      id: session.liveSessionId,
      status: 'active',
      startedAt: expect.any(String) as unknown as string,
      closedAt: null,
    });

    // Status discovery must not create a Participant row.
    const count = await prisma.prisma.participant.count({
      where: {
        liveSessionId: session.liveSessionId,
        accountId: student.accountId,
      },
    });
    expect(count).toBe(0);
  });

  it('returns waiting with null timestamps before start', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    // Build a waiting (not-yet-started) session directly.
    const course = await teacher.auth.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ name: 'Student Status Waiting Course' });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;
    const question = await teacher.auth.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({
        type: 'poll',
        prompt: 'Which option?',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(question.status).toBe(201);
    const waitingSession = await teacher.auth.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ courseId, questionIds: [question.body.data.id] });
    expect(waitingSession.status).toBe(201);
    const waitingSessionId = waitingSession.body.data.id as string;
    await enrollStudent(teacher.auth, courseId, student.accountId);

    const response = await student.auth.agent.get(
      `/api/v1/live-sessions/${waitingSessionId}/student-status`,
    );
    expect(response.status).toBe(200);
    expectExactReceipt(response.body.data as Record<string, unknown>, {
      id: waitingSessionId,
      status: 'waiting',
      startedAt: null,
      closedAt: null,
    });
  });

  it('returns a closed receipt after close and archive anonymization', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(
      teacher.auth,
      'Student Status Closed Course',
    );
    await enrollStudent(teacher.auth, session.courseId, student.accountId);

    // Close the session (close also archives and anonymizes participants).
    const closed = await teacher.auth.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(closed.status).toBe(201);

    // The archived session must have anonymized any account-bound
    // participants; verify the anonymization precondition directly.
    const archived = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: session.liveSessionId },
      select: { status: true, closedAt: true },
    });
    expect(archived.status).toBe('closed');
    expect(archived.closedAt).toBeTruthy();

    const response = await student.auth.agent
      .get(`/api/v1/live-sessions/${session.liveSessionId}/student-status`)
      .set('X-Participant-Token', 'ignored-bearer-value');
    expect(response.status).toBe(200);
    expectExactReceipt(response.body.data as Record<string, unknown>, {
      id: session.liveSessionId,
      status: 'closed',
      startedAt: expect.any(String) as unknown as string,
      closedAt: expect.any(String) as unknown as string,
    });
  });

  it('returns a cancelled receipt with null closedAt', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    // Cancel is the discard path for a not-yet-started (waiting) session.
    const course = await teacher.auth.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ name: 'Student Status Cancelled Course' });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;
    const question = await teacher.auth.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({
        type: 'poll',
        prompt: 'Which option?',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(question.status).toBe(201);
    const waiting = await teacher.auth.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ courseId, questionIds: [question.body.data.id] });
    expect(waiting.status).toBe(201);
    const waitingSessionId = waiting.body.data.id as string;
    await enrollStudent(teacher.auth, courseId, student.accountId);

    const cancelled = await teacher.auth.agent
      .post(`/api/v1/live-sessions/${waitingSessionId}/cancel`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(cancelled.status).toBe(201);

    const response = await student.auth.agent.get(
      `/api/v1/live-sessions/${waitingSessionId}/student-status`,
    );
    expect(response.status).toBe(200);
    expectExactReceipt(response.body.data as Record<string, unknown>, {
      id: waitingSessionId,
      status: 'cancelled',
      startedAt: null,
      closedAt: null,
    });
  });

  it('rejects a student without enrollment and after enrollment removal', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(
      teacher.auth,
      'Student Status Enrollment Course',
    );

    // No enrollment row yet.
    const missing = await student.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/student-status`,
    );
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('ENROLLMENT_REQUIRED');

    await enrollStudent(teacher.auth, session.courseId, student.accountId);
    const ok = await student.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/student-status`,
    );
    expect(ok.status).toBe(200);

    const removed = await teacher.auth.agent
      .delete(
        `/api/v1/courses/${session.courseId}/enrollments/${student.accountId}`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(removed.status).toBe(200);

    const removedStatus = await student.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/student-status`,
    );
    expect(removedStatus.status).toBe(403);
    expect(removedStatus.body.error.code).toBe('ENROLLMENT_REMOVED');
  });

  it('rejects teacher/admin, anonymous, and malformed requests', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(
      teacher.auth,
      'Student Status Boundary Course',
    );
    await enrollStudent(teacher.auth, session.courseId, student.accountId);

    // Teacher cookie → generic FORBIDDEN.
    const teacherView = await teacher.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/student-status`,
    );
    expect(teacherView.status).toBe(403);
    expect(teacherView.body.error.code).toBe('FORBIDDEN');

    // Admin cookie → generic FORBIDDEN.
    const adminView = await admin.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/student-status`,
    );
    expect(adminView.status).toBe(403);

    // Anonymous caller → UNAUTHORIZED.
    const anonymous = await request(app.getHttpServer()).get(
      `/api/v1/live-sessions/${session.liveSessionId}/student-status`,
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHORIZED');

    // Unknown session UUID (valid shape, nonexistent row).
    const unknownId = '0198c7a2-0000-7000-8000-00000000fff1';
    const unknown = await student.auth.agent.get(
      `/api/v1/live-sessions/${unknownId}/student-status`,
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');

    // Malformed UUID → 400 from ParseUUIDPipe.
    const malformed = await student.auth.agent.get(
      '/api/v1/live-sessions/not-a-uuid/student-status',
    );
    expect(malformed.status).toBe(400);
  });

  it('classifies a valid cookie for a disabled account as AUTH_ACCOUNT_DISABLED', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(
      teacher.auth,
      'Student Status Disabled Course',
    );
    await enrollStudent(teacher.auth, session.courseId, student.accountId);

    // Mutate only the account row so the already-issued cookie reaches the
    // participant-bound session classifier. The production disable route also
    // revokes sessions (covered by participant-revocation e2e).
    await prisma.prisma.account.update({
      where: { id: student.accountId },
      data: { status: 'disabled' },
    });

    const disabled = await student.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/student-status`,
    );
    expect(disabled.status).toBe(401);
    expect(disabled.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
  });

  it('expired session maps to AUTH_SESSION_EXPIRED', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(
      teacher.auth,
      'Student Status Expiry Course',
    );
    await enrollStudent(teacher.auth, session.courseId, student.accountId);

    // Expire the persisted session row in place, preserving the cookie: push
    // lastSeenAt beyond the idle window and expiresAt beyond the absolute
    // one. Target the still-active session (the final login after the
    // temporary-password rotation), not an earlier revoked row.
    const sessionRow = await prisma.prisma.webSession.findFirstOrThrow({
      where: { accountId: student.accountId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    await prisma.prisma.webSession.update({
      where: { id: sessionRow.id },
      data: {
        lastSeenAt: new Date(Date.now() - 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const expired = await student.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/student-status`,
    );
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('AUTH_SESSION_EXPIRED');
  });
});
