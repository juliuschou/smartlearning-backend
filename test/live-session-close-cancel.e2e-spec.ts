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
