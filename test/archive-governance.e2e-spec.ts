import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import { createTestApp } from './setup/app-factory';
import { GovernanceService } from '../src/modules/governance/application/governance.service';
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

  it('finalizes an anonymous archive and enforces ownership/privacy', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
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
    const session = await createStartedSession(teacher);
    const closed = await teacher.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(closed.status).toBe(201);
    const archive = await prisma.prisma.archivedResult.findUnique({
      where: { liveSessionId: session.liveSessionId },
    });
    expect(archive?.status).toBe('active');
    expect(archive?.payload).toMatchObject({ schemaVersion: 1 });
    expect(
      (archive?.payload as { questions: unknown[] }).questions,
    ).toHaveLength(1);
    expect(archive?.purgeAt.getTime()).toBe(
      archive!.closedAt.getTime() + 90 * 24 * 60 * 60 * 1000,
    );
    const detail = await teacher.agent.get(
      `/api/v1/results/${session.liveSessionId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.payload).toMatchObject({ schemaVersion: 1 });
    const hidden = await other.agent.get(
      `/api/v1/results/${session.liveSessionId}`,
    );
    expect(hidden.status).toBe(404);
    expectErrorEnvelope(hidden, 'NOT_FOUND');
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const adminDetail = await admin.agent.get(
      `/api/v1/results/${session.liveSessionId}`,
    );
    expect(adminDetail.status).toBe(200);
    const list = await teacher.agent.get('/api/v1/results');
    expect(list.status).toBe(200);
    expect(list.body.data.data).toHaveLength(1);
  });

  it('serializes deletion requests and requires CSRF, step-up, confirmation, and request', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const session = await createStartedSession(teacher);
    const close = await teacher.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(close.status).toBe(201);
    const path = `/api/v1/results/${session.liveSessionId}/deletion-requests`;
    const missingCsrf = await teacher.agent
      .post(path)
      .set('Origin', TEST_ORIGIN)
      .send({ reason: 'privacy' });
    expect(missingCsrf.status).toBe(403);
    expectErrorEnvelope(missingCsrf, 'AUTH_CSRF_INVALID');
    const first = await teacher.agent
      .post(path)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ reason: 'privacy' });
    const second = await teacher.agent
      .post(path)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ reason: 'support' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(
      await prisma.prisma.deletionEvent.count({
        where: {
          liveSessionId: session.liveSessionId,
          trigger: 'teacher_request',
          status: 'requested',
        },
      }),
    ).toBe(1);
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const noStep = await admin.agent
      .post(`/api/v1/admin/results/${session.liveSessionId}/deletion`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ confirmed: true, reason: 'privacy' });
    expect(noStep.status).toBe(403);
    expectErrorEnvelope(noStep, 'AUTH_STEP_UP_REQUIRED');
    const step = await admin.agent
      .post('/api/v1/auth/step-up')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ password: ADMIN.password });
    expect(step.status).toBe(201);
    const unconfirmed = await admin.agent
      .post(`/api/v1/admin/results/${session.liveSessionId}/deletion`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ confirmed: false, reason: 'privacy' });
    expect(unconfirmed.status).toBe(409);
    const deleted = await admin.agent
      .post(`/api/v1/admin/results/${session.liveSessionId}/deletion`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ confirmed: true, reason: 'privacy' });
    expect(deleted.status).toBe(201);
    const tombstone = await admin.agent.get(
      `/api/v1/results/${session.liveSessionId}`,
    );
    expect(tombstone.status).toBe(200);
    expect(tombstone.body.data.status).toBe('deleted');
    expect(tombstone.body.data).not.toHaveProperty('payload');
    expect(
      await prisma.prisma.archivedResult.findUnique({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toMatchObject({ status: 'deleted', payload: null });
    expect(
      await prisma.prisma.sessionQuestion.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.liveSession.findUnique({
        where: { id: session.liveSessionId },
        select: { status: true, closedAt: true },
      }),
    ).toMatchObject({ status: 'closed' });
  });

  it('purges due archives and leaves an idempotent tombstone', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const session = await createStartedSession(teacher);
    const close = await teacher.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(close.status).toBe(201);
    const archive = await prisma.prisma.archivedResult.findUniqueOrThrow({
      where: { liveSessionId: session.liveSessionId },
    });
    const governance = app.get(GovernanceService);
    const now = new Date(archive.purgeAt.getTime() + 1);
    await expect(
      governance.purgeOne(
        session.liveSessionId,
        'retention',
        undefined,
        'retention',
        new Date(archive.purgeAt.getTime() - 1),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      governance.purgeOne(
        session.liveSessionId,
        'retention',
        undefined,
        'retention',
        now,
      ),
    ).resolves.toEqual({ status: 'success' });
    await expect(
      governance.purgeOne(
        session.liveSessionId,
        'retention',
        undefined,
        'retention',
        now,
      ),
    ).resolves.toEqual({ status: 'success' });
    expect(
      await prisma.prisma.deletionEvent.count({
        where: {
          liveSessionId: session.liveSessionId,
          trigger: 'retention',
          status: 'success',
        },
      }),
    ).toBe(1);
  });
});
