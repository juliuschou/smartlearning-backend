import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('LiveSession close/cancel (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'close-cancel-e2e-admin',
    displayName: 'Close Cancel E2E Admin',
    password: 'close-cancel-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'close-cancel-e2e-teacher',
    displayName: 'Close Cancel E2E Teacher',
    tempPassword: 'close-cancel-e2e-temp-password-1234',
    password: 'close-cancel-e2e-final-password-1234',
  };
  const OTHER_TEACHER = {
    username: 'close-cancel-e2e-other',
    displayName: 'Close Cancel E2E Other',
    tempPassword: 'close-cancel-e2e-other-temp-1234',
    password: 'close-cancel-e2e-other-final-1234',
  };
  const STUDENT = {
    username: 'close-cancel-e2e-student',
    displayName: 'Close Cancel E2E Student',
    tempPassword: 'close-cancel-e2e-student-temp-1234',
    password: 'close-cancel-e2e-student-final-1234',
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
      // Keep the suite blocked when any migration fails; do not probe stale schema.
    }
    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);
    if (!migrationsReady) return;
    try {
      await prisma.prisma.$queryRaw`SELECT 1 FROM question_definition LIMIT 0`;
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

  async function provisionTeacher(
    username: string,
    displayName: string,
    tempPassword: string,
    finalPassword: string,
  ): Promise<AuthenticatedAgent> {
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const created = await admin.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        username,
        displayName,
        role: AccountRole.TEACHER,
        canCreateCourse: true,
        tempPassword,
      });
    expect(created.status).toBe(201);

    const temporary = await loginAs(username, tempPassword);
    const changed = await temporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, temporary.csrfToken)
      .send({ currentPassword: tempPassword, newPassword: finalPassword });
    expect(changed.status).toBe(201);
    return loginAs(username, finalPassword);
  }

  async function provisionStudent(): Promise<AuthenticatedAgent> {
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const created = await admin.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        username: STUDENT.username,
        displayName: STUDENT.displayName,
        role: AccountRole.STUDENT,
        canCreateCourse: true,
        tempPassword: STUDENT.tempPassword,
      });
    expect(created.status).toBe(201);
    expect(created.body.data.role).toBe(AccountRole.STUDENT);
    expect(created.body.data.canCreateCourse).toBe(false);

    const temporary = await loginAs(STUDENT.username, STUDENT.tempPassword);
    const changed = await temporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, temporary.csrfToken)
      .send({
        currentPassword: STUDENT.tempPassword,
        newPassword: STUDENT.password,
      });
    expect(changed.status).toBe(201);
    return loginAs(STUDENT.username, STUDENT.password);
  }

  function expectSuccessEnvelope(response: request.Response): void {
    expect(response.body.data).toBeDefined();
    expect(response.body.error).toBeNull();
    expect(response.body.meta.schemaVersion).toBe(1);
    expect(response.body.meta.requestId).toBe(response.headers['x-request-id']);
  }

  function expectErrorEnvelope(
    response: request.Response,
    expectedCode: string,
  ): void {
    expect(response.body.data).toBeNull();
    expect(response.body.meta.schemaVersion).toBe(1);
    expect(response.body.meta.requestId).toBe(response.headers['x-request-id']);
    expect(response.body.error).toEqual(
      expect.objectContaining({ code: expectedCode }),
    );
  }

  async function createStartedSession(teacher: AuthenticatedAgent): Promise<{
    liveSessionId: string;
    sessionQuestionId: string;
  }> {
    const courseResponse = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Close Cancel Course', description: 'slice' });
    expect(courseResponse.status).toBe(201);
    const courseId = courseResponse.body.data.id as string;

    const questionResponse = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '哪一個概念最想釐清？',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: '選項 A' },
          { optionRef: 'b', text: '選項 B' },
        ],
      });
    expect(questionResponse.status).toBe(201);
    const questionId = questionResponse.body.data.id as string;

    const waitingResponse = await teacher.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ courseId, questionIds: [questionId] });
    expect(waitingResponse.status).toBe(201);
    const liveSessionId = waitingResponse.body.data.id as string;

    const startResponse = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/start`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(startResponse.status).toBe(201);
    const sessionQuestionId = startResponse.body.data.sessionQuestions[0]
      .id as string;
    return { liveSessionId, sessionQuestionId };
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for close/cancel e2e tests.',
      );
    }
  }

  it('starts a waiting session once and creates one immutable snapshot set', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );

    const courseResponse = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Start Session Course', description: 'slice' });
    expect(courseResponse.status).toBe(201);
    const courseId = courseResponse.body.data.id as string;

    const questionResponse = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '開始前固定的題目',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: '選項 A' },
          { optionRef: 'b', text: '選項 B' },
        ],
      });
    expect(questionResponse.status).toBe(201);
    const questionId = questionResponse.body.data.id as string;

    const waitingResponse = await teacher.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ courseId, questionIds: [questionId] });
    expect(waitingResponse.status).toBe(201);
    const liveSessionId = waitingResponse.body.data.id as string;

    const startResponse = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/start`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(startResponse.status).toBe(201);
    expect(startResponse.body.data.status).toBe('active');
    expect(startResponse.body.data.startedAt).not.toBeNull();
    expect(startResponse.body.data.sessionQuestions).toHaveLength(1);

    const firstSnapshotId = startResponse.body.data.sessionQuestions[0].id;
    const repeatedStart = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/start`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(repeatedStart.status).toBe(409);
    expect(repeatedStart.body.error.code).toBe('CONFLICT');

    const snapshots = await prisma.prisma.sessionQuestion.findMany({
      where: { liveSessionId },
      select: { id: true, snapshotPrompt: true },
    });
    expect(snapshots).toEqual([
      { id: firstSnapshotId, snapshotPrompt: '開始前固定的題目' },
    ]);
  });

  it('closes an active session, closes its open question, records closedAt with autoClosed=false', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const { liveSessionId, sessionQuestionId } =
      await createStartedSession(teacher);

    const openResponse = await teacher.agent
      .post(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(openResponse.status).toBe(201);
    expect(openResponse.body.data.status).toBe('open');

    const closeResponse = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(closeResponse.status).toBe(201);
    expect(closeResponse.body.data.status).toBe('closed');
    expect(closeResponse.body.data.closedAt).not.toBeNull();
    expect(closeResponse.body.data.autoClosed).toBe(false);
    const closedQuestion = closeResponse.body.data.sessionQuestions.find(
      (q: { id: string }) => q.id === sessionQuestionId,
    );
    expect(closedQuestion.status).toBe('closed');
    expect(closedQuestion.closedAt).not.toBeNull();
  });

  it('rejects closing a session that is not active', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const { liveSessionId } = await createStartedSession(teacher);

    // waiting session created separately (the started one above is active) —
    // close the active one first, then retry close on the now-closed session.
    const firstClose = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(firstClose.status).toBe(201);

    const secondClose = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(secondClose.status).toBe(409);
    expect(secondClose.body.error.code).toBe('CONFLICT');
  });

  it('cancels a waiting session without recording closedAt', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );

    const courseResponse = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Cancel Waiting Course', description: 'slice' });
    expect(courseResponse.status).toBe(201);
    const courseId = courseResponse.body.data.id as string;

    const questionResponse = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '哪一個概念最想釐清？',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: '選項 A' },
          { optionRef: 'b', text: '選項 B' },
        ],
      });
    expect(questionResponse.status).toBe(201);
    const questionId = questionResponse.body.data.id as string;

    const waitingResponse = await teacher.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ courseId, questionIds: [questionId] });
    expect(waitingResponse.status).toBe(201);
    const liveSessionId = waitingResponse.body.data.id as string;

    const cancelResponse = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/cancel`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(cancelResponse.status).toBe(201);
    expect(cancelResponse.body.data.status).toBe('cancelled');
    expect(cancelResponse.body.data.closedAt).toBeNull();

    const secondCancel = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/cancel`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(secondCancel.status).toBe(409);
    expect(secondCancel.body.error.code).toBe('CONFLICT');
  });

  it('rejects cancelling an active session and preserves its state', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const { liveSessionId } = await createStartedSession(teacher);

    const cancelResponse = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/cancel`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);

    expect(cancelResponse.status).toBe(409);
    expect(cancelResponse.body.data).toBeNull();
    expect(cancelResponse.body.error.code).toBe('CONFLICT');

    const session = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: liveSessionId },
      select: { status: true, closedAt: true },
    });
    expect(session.status).toBe('active');
    expect(session.closedAt).toBeNull();
  });

  it('rejects close/cancel from a non-owner teacher with 404 (no existence leak)', async () => {
    requireDatabase();
    const owner = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const other = await provisionTeacher(
      OTHER_TEACHER.username,
      OTHER_TEACHER.displayName,
      OTHER_TEACHER.tempPassword,
      OTHER_TEACHER.password,
    );
    const { liveSessionId } = await createStartedSession(owner);

    const closeByOther = await other.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, other.csrfToken);
    expect(closeByOther.status).toBe(404);
    expect(closeByOther.body.error.code).toBe('NOT_FOUND');

    const cancelByOther = await other.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/cancel`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, other.csrfToken);
    expect(cancelByOther.status).toBe(404);
    expect(cancelByOther.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects close without authentication (401) and without CSRF (403)', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const { liveSessionId } = await createStartedSession(teacher);

    const unauthenticated = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN);
    expect(unauthenticated.status).toBe(401);

    // Authenticated but missing CSRF token.
    const noCsrf = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN);
    expect(noCsrf.status).toBe(403);
  });

  it('rejects student control access and allows admin cross-owner control', async () => {
    requireDatabase();
    const owner = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const student = await provisionStudent();
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const { liveSessionId } = await createStartedSession(owner);

    const studentClose = await student.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.csrfToken);
    expect(studentClose.status).toBe(403);
    expectErrorEnvelope(studentClose, 'FORBIDDEN');

    const adminDetail = await admin.agent.get(
      `/api/v1/live-sessions/${liveSessionId}`,
    );
    expect(adminDetail.status).toBe(200);
    expectSuccessEnvelope(adminDetail);

    const adminClose = await admin.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(adminClose.status).toBe(201);
    expectSuccessEnvelope(adminClose);
    expect(adminClose.body.data.status).toBe('closed');
  });

  it('rejects student cancellation and wrong CSRF or Origin without side effects', async () => {
    requireDatabase();
    const owner = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const student = await provisionStudent();
    const { liveSessionId } = await createStartedSession(owner);

    const studentCancel = await student.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/cancel`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.csrfToken);
    expect(studentCancel.status).toBe(403);
    expectErrorEnvelope(studentCancel, 'FORBIDDEN');

    const wrongCsrf = await owner.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/cancel`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, 'wrong-csrf-token');
    expect(wrongCsrf.status).toBe(403);
    expectErrorEnvelope(wrongCsrf, 'AUTH_CSRF_INVALID');

    const wrongOrigin = await owner.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/cancel`)
      .set('Origin', 'https://attacker.example')
      .set(CSRF_HEADER, owner.csrfToken);
    expect(wrongOrigin.status).toBe(403);
    expectErrorEnvelope(wrongOrigin, 'AUTH_CSRF_INVALID');

    const session = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: liveSessionId },
      select: { status: true, closedAt: true },
    });
    expect(session.status).toBe('active');
    expect(session.closedAt).toBeNull();
  });

  it('preserves envelope and redaction invariants on control responses', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const { liveSessionId } = await createStartedSession(teacher);

    const closeResponse = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(closeResponse.status).toBe(201);
    expectSuccessEnvelope(closeResponse);
    expect(closeResponse.body.data).not.toHaveProperty('passwordHash');
    expect(closeResponse.body.data).not.toHaveProperty('cookieHash');
    expect(closeResponse.body.data).not.toHaveProperty('tokenHash');
    expect(closeResponse.body.data).not.toHaveProperty('participantToken');

    const repeated = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(repeated.status).toBe(409);
    expectErrorEnvelope(repeated, 'CONFLICT');
  });

  it('rejects student access to the session detail control projection', async () => {
    requireDatabase();
    const owner = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const student = await provisionStudent();
    const { liveSessionId } = await createStartedSession(owner);

    const response = await student.agent.get(
      `/api/v1/live-sessions/${liveSessionId}`,
    );
    expect(response.status).toBe(403);
    expectErrorEnvelope(response, 'FORBIDDEN');
  });

  it('returns 404 for close/cancel on an unknown liveSessionId', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const unknownId = '0190c6b8-0000-7000-8000-000000009999';

    const closeUnknown = await teacher.agent
      .post(`/api/v1/live-sessions/${unknownId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(closeUnknown.status).toBe(404);

    const cancelUnknown = await teacher.agent
      .post(`/api/v1/live-sessions/${unknownId}/cancel`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(cancelUnknown.status).toBe(404);
  });
});
