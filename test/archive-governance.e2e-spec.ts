import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { hashToken, newId } from '../src/common/crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { GovernanceService } from '../src/modules/governance/application/governance.service';
import { RealtimeVisibility } from '../src/modules/realtime/live-session-realtime-contract';
import { Prisma } from '../generated/prisma/client';
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
    username: 'archive-governance-e2e-student',
    displayName: 'Archive Governance E2E Student',
    tempPassword: 'archive-governance-e2e-student-temp-1234',
    password: 'archive-governance-e2e-student-final-1234',
  };

  type AuthenticatedAgent = {
    agent: request.SuperAgentTest;
    csrfToken: string;
    sessionToken: string;
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
      sessionToken: cookieValue(setCookie, '__Host-session'),
    };
  }

  async function provisionAccount(
    username: string,
    displayName: string,
    tempPassword: string,
    finalPassword: string,
    role: AccountRole,
  ): Promise<AuthenticatedAgent> {
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const created = await admin.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        username,
        displayName,
        role,
        canCreateCourse: role === AccountRole.TEACHER,
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

  async function provisionTeacher(
    username: string,
    displayName: string,
    tempPassword: string,
    finalPassword: string,
  ): Promise<AuthenticatedAgent> {
    return provisionAccount(
      username,
      displayName,
      tempPassword,
      finalPassword,
      AccountRole.TEACHER,
    );
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
    courseId: string;
    liveSessionId: string;
    sessionCode: string;
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
    const sessionCode = waitingResponse.body.data.sessionCode as string;

    const startResponse = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/start`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(startResponse.status).toBe(201);
    const sessionQuestionId = startResponse.body.data.sessionQuestions[0]
      .id as string;
    return { courseId, liveSessionId, sessionCode, sessionQuestionId };
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
    const student = await provisionAccount(
      STUDENT.username,
      STUDENT.displayName,
      STUDENT.tempPassword,
      STUDENT.password,
      AccountRole.STUDENT,
    );
    const session = await createStartedSession(teacher);
    const joined = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .send({ displayName: 'Known participant' });
    expect(joined.status).toBe(201);
    const participantId = joined.body.data.participantId as string;
    const participantToken = joined.body.data.participantToken as string;
    const opened = await teacher.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(opened.status).toBe(201);
    const submitted = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.liveSessionId}/submissions`)
      .set('X-Participant-Token', participantToken)
      .set('Idempotency-Key', newId())
      .send({
        sessionQuestionId: session.sessionQuestionId,
        selectedOptionRefs: ['a'],
      });
    expect(submitted.status).toBe(201);
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
    const participant = await prisma.prisma.participant.findUnique({
      where: { id: participantId },
    });
    expect(participant).toMatchObject({
      accountId: null,
      displayName: 'Anonymous',
    });
    expect(
      await prisma.prisma.submission.findUnique({
        where: { id: submitted.body.data.id as string },
        select: { participantId: true },
      }),
    ).toEqual({ participantId });
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

    for (const response of [
      await student.agent.get('/api/v1/results'),
      await student.agent.get(`/api/v1/results/${session.liveSessionId}`),
      await student.agent
        .post(`/api/v1/results/${session.liveSessionId}/deletion-requests`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, student.csrfToken)
        .send({ reason: 'privacy' }),
    ]) {
      expect(response.status).toBe(403);
      expectErrorEnvelope(response, 'FORBIDDEN');
    }
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
      .send({
        deletionRequestId: first.body.data.id,
        confirmed: true,
        reason: 'privacy',
      });
    expect(noStep.status).toBe(403);
    expectErrorEnvelope(noStep, 'AUTH_STEP_UP_REQUIRED');
    const step = await admin.agent
      .post('/api/v1/auth/step-up')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ password: ADMIN.password });
    expect(step.status).toBe(201);
    const otherAdmin = await loginAs(ADMIN.username, ADMIN.password);
    const crossSession = await otherAdmin.agent
      .post(`/api/v1/admin/results/${session.liveSessionId}/deletion`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, otherAdmin.csrfToken)
      .send({
        deletionRequestId: first.body.data.id,
        confirmed: true,
        reason: 'privacy',
      });
    expect(crossSession.status).toBe(403);
    expectErrorEnvelope(crossSession, 'AUTH_STEP_UP_REQUIRED');

    const steppedUpSession = await prisma.prisma.webSession.findUnique({
      where: { cookieHash: hashToken(admin.sessionToken) },
    });
    await prisma.prisma.webSession.update({
      where: { id: steppedUpSession!.id },
      data: { stepUpAt: new Date(Date.now() - 11 * 60 * 1000) },
    });
    const expiredStepUp = await admin.agent
      .post(`/api/v1/admin/results/${session.liveSessionId}/deletion`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        deletionRequestId: first.body.data.id,
        confirmed: true,
        reason: 'privacy',
      });
    expect(expiredStepUp.status).toBe(403);
    expectErrorEnvelope(expiredStepUp, 'AUTH_STEP_UP_REQUIRED');
    expect(
      (
        await admin.agent
          .post('/api/v1/auth/step-up')
          .set('Origin', TEST_ORIGIN)
          .set(CSRF_HEADER, admin.csrfToken)
          .send({ password: ADMIN.password })
      ).status,
    ).toBe(201);

    const wrongReason = await admin.agent
      .post(`/api/v1/admin/results/${session.liveSessionId}/deletion`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        deletionRequestId: first.body.data.id,
        confirmed: true,
        reason: 'support',
      });
    expect(wrongReason.status).toBe(409);
    expectErrorEnvelope(wrongReason, 'CONFLICT');
    expect(wrongReason.body.error.field).toBe('reason');
    expect(
      await prisma.prisma.archivedResult.findUnique({
        where: { liveSessionId: session.liveSessionId },
        select: { status: true },
      }),
    ).toEqual({ status: 'active' });
    expect(
      await prisma.prisma.deletionEvent.count({
        where: {
          liveSessionId: session.liveSessionId,
          trigger: { in: ['early_delete', 'retention'] },
        },
      }),
    ).toBe(0);

    const unconfirmed = await admin.agent
      .post(`/api/v1/admin/results/${session.liveSessionId}/deletion`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        deletionRequestId: first.body.data.id,
        confirmed: false,
        reason: 'privacy',
      });
    expect(unconfirmed.status).toBe(400);
    const deleted = await admin.agent
      .post(`/api/v1/admin/results/${session.liveSessionId}/deletion`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        deletionRequestId: first.body.data.id,
        confirmed: true,
        reason: 'privacy',
      });
    expect(deleted.status).toBe(201);
    const conflictingReplay = await admin.agent
      .post(`/api/v1/admin/results/${session.liveSessionId}/deletion`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        deletionRequestId: first.body.data.id,
        confirmed: true,
        reason: 'support',
      });
    expect(conflictingReplay.status).toBe(409);
    expectErrorEnvelope(conflictingReplay, 'CONFLICT');
    expect(conflictingReplay.body.error.field).toBe('reason');
    expect(
      await prisma.prisma.deletionEvent.count({
        where: {
          liveSessionId: session.liveSessionId,
          trigger: { in: ['early_delete', 'retention'] },
          status: 'success',
        },
      }),
    ).toBe(1);

    const tombstone = await admin.agent.get(
      `/api/v1/results/${session.liveSessionId}`,
    );
    expect(tombstone.status).toBe(200);
    expect(tombstone.body.data.status).toBe('deleted');
    expect(tombstone.body.data).not.toHaveProperty('payload');
    const deletedPage = await admin.agent
      .get('/api/v1/results')
      .query({ status: 'deleted' });
    expect(deletedPage.status).toBe(200);
    expect(deletedPage.body.data.data).toHaveLength(1);
    expect(deletedPage.body.data.data[0].liveSessionId).toBe(
      session.liveSessionId,
    );
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

  it('filters archive pages before pagination and uses deterministic tie ordering', async () => {
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
    const first = await createStartedSession(teacher);
    const second = await createStartedSession(teacher);
    const foreign = await createStartedSession(other);
    for (const session of [first, second, foreign]) {
      expect(
        (
          await (session === foreign ? other : teacher).agent
            .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
            .set('Origin', TEST_ORIGIN)
            .set(CSRF_HEADER, (session === foreign ? other : teacher).csrfToken)
        ).status,
      ).toBe(201);
    }
    const tiedAt = new Date('2026-09-08T00:00:00.000Z');
    await prisma.prisma.archivedResult.updateMany({
      where: {
        liveSessionId: { in: [first.liveSessionId, second.liveSessionId] },
      },
      data: { closedAt: tiedAt },
    });

    const page = await teacher.agent.get('/api/v1/results').query({
      page: 1,
      pageSize: 20,
      status: 'active',
    });
    expect(page.status).toBe(200);
    expect(page.body.data.data.map((row: { id: string }) => row.id)).toEqual(
      [...page.body.data.data.map((row: { id: string }) => row.id)]
        .sort()
        .reverse(),
    );
    expect(
      page.body.data.data.some(
        (row: { liveSessionId: string }) =>
          row.liveSessionId === foreign.liveSessionId,
      ),
    ).toBe(false);

    const byCourse = await teacher.agent
      .get('/api/v1/results')
      .query({ courseId: first.courseId, status: 'active' });
    expect(byCourse.status).toBe(200);
    expect(byCourse.body.data.data).toHaveLength(1);
    expect(byCourse.body.data.data[0].liveSessionId).toBe(first.liveSessionId);

    const foreignFilter = await teacher.agent
      .get('/api/v1/results')
      .query({ courseId: foreign.courseId });
    expect(foreignFilter.status).toBe(200);
    expect(foreignFilter.body.data).toMatchObject({
      data: [],
      meta: { total: 0 },
    });

    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const globalPage = await admin.agent
      .get('/api/v1/results')
      .query({ page: 1, pageSize: 2, status: 'active' });
    expect(globalPage.status).toBe(200);
    expect(globalPage.body.data).toMatchObject({
      meta: { page: 1, pageSize: 2, total: 3, totalPages: 2 },
    });
    expect(globalPage.body.data.data).toHaveLength(2);
  });

  it('validates archive and deletion-request list query contracts', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const session = await createStartedSession(teacher);
    expect(
      (
        await teacher.agent
          .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
          .set('Origin', TEST_ORIGIN)
          .set(CSRF_HEADER, teacher.csrfToken)
      ).status,
    ).toBe(201);

    for (const query of [
      { page: 0 },
      { page: -1 },
      { page: 1.5 },
      { pageSize: 0 },
      { pageSize: 101 },
      { pageSize: 1.5 },
      { courseId: 'not-a-uuid' },
      { status: 'unknown' },
      { unexpected: 'field' },
    ]) {
      const response = await teacher.agent.get('/api/v1/results').query(query);
      expect(response.status).toBe(400);
      expectErrorEnvelope(response, 'VALIDATION_FAILED');
    }

    const combined = await teacher.agent.get('/api/v1/results').query({
      courseId: session.courseId,
      status: 'active',
      page: 1,
      pageSize: 1,
    });
    expect(combined.status).toBe(200);
    expect(combined.body.data).toMatchObject({
      meta: { page: 1, pageSize: 1, total: 1, totalPages: 1 },
    });

    const admin = await loginAs(ADMIN.username, ADMIN.password);
    for (const query of [
      { page: 0 },
      { pageSize: 101 },
      { status: 'success' },
      { unexpected: 'field' },
    ]) {
      const response = await admin.agent
        .get('/api/v1/admin/results/deletion-requests')
        .query(query);
      expect(response.status).toBe(400);
      expectErrorEnvelope(response, 'VALIDATION_FAILED');
    }
  });

  it('fails closed at the deletion-request authorization and CSRF boundary', async () => {
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
    expect(
      (
        await teacher.agent
          .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
          .set('Origin', TEST_ORIGIN)
          .set(CSRF_HEADER, teacher.csrfToken)
      ).status,
    ).toBe(201);
    const path = `/api/v1/results/${session.liveSessionId}/deletion-requests`;

    for (const response of [
      await teacher.agent
        .post(path)
        .set(CSRF_HEADER, teacher.csrfToken)
        .send({ reason: 'privacy' }),
      await teacher.agent
        .post(path)
        .set('Origin', 'http://evil.test')
        .set(CSRF_HEADER, teacher.csrfToken)
        .send({ reason: 'privacy' }),
      await teacher.agent
        .post(path)
        .set('Origin', `${TEST_ORIGIN}.evil.test`)
        .set(CSRF_HEADER, teacher.csrfToken)
        .send({ reason: 'privacy' }),
      await teacher.agent
        .post(path)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, 'wrong-token')
        .send({ reason: 'privacy' }),
    ]) {
      expect(response.status).toBe(403);
      expectErrorEnvelope(response, 'AUTH_CSRF_INVALID');
    }
    expect(
      await prisma.prisma.deletionEvent.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);

    const foreign = await other.agent
      .post(path)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, other.csrfToken)
      .send({ reason: 'privacy' });
    expect(foreign.status).toBe(404);
    expectErrorEnvelope(foreign, 'NOT_FOUND');

    const missing = await teacher.agent
      .post(`/api/v1/results/${newId()}/deletion-requests`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ reason: 'privacy' });
    expect(missing.status).toBe(404);
    expectErrorEnvelope(missing, 'NOT_FOUND');
    expect(missing.body.error).toEqual(foreign.body.error);

    const malformed = await teacher.agent
      .post('/api/v1/results/not-a-uuid/deletion-requests')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ reason: 'privacy' });
    expect(malformed.status).toBe(400);
    expectErrorEnvelope(malformed, 'VALIDATION_FAILED');

    const invalidReason = await teacher.agent
      .post(path)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ reason: 'unknown' });
    expect(invalidReason.status).toBe(400);
    expectErrorEnvelope(invalidReason, 'VALIDATION_FAILED');

    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const adminRequest = await admin.agent
      .post(path)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ reason: 'privacy' });
    expect(adminRequest.status).toBe(403);
    expectErrorEnvelope(adminRequest, 'FORBIDDEN');
  });

  it('exposes a private admin queue and preserves one request receipt under concurrency', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const session = await createStartedSession(teacher);
    expect(
      (
        await teacher.agent
          .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
          .set('Origin', TEST_ORIGIN)
          .set(CSRF_HEADER, teacher.csrfToken)
      ).status,
    ).toBe(201);
    const path = `/api/v1/results/${session.liveSessionId}/deletion-requests`;
    const first = await teacher.agent
      .post(path)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ reason: 'privacy' });
    const concurrent = await Promise.all([
      teacher.agent
        .post(path)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, teacher.csrfToken)
        .send({ reason: 'support' }),
      teacher.agent
        .post(path)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, teacher.csrfToken)
        .send({ reason: 'support' }),
    ]);
    expect(first.status).toBe(201);
    for (const replay of concurrent) {
      expect(replay.status).toBe(201);
      expect(replay.body.data).toEqual(first.body.data);
    }
    expect(first.body.data.reason).toBe('privacy');

    const teacherQueue = await teacher.agent.get(
      '/api/v1/admin/results/deletion-requests',
    );
    expect(teacherQueue.status).toBe(403);
    const anonymousQueue = await request(app.getHttpServer()).get(
      '/api/v1/admin/results/deletion-requests',
    );
    expect(anonymousQueue.status).toBe(401);

    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const queue = await admin.agent.get(
      '/api/v1/admin/results/deletion-requests',
    );
    expect(queue.status).toBe(200);
    expect(queue.body.data.data).toHaveLength(1);
    expect(queue.body.data.data[0]).toMatchObject({
      id: first.body.data.id,
      liveSessionId: session.liveSessionId,
      status: 'requested',
    });
    expect(JSON.stringify(queue.body.data)).not.toMatch(
      /requesterId|executorId|displayName|username|token|payload|prompt|submission/i,
    );
  });

  it('binds confirmation to its request, replays canonically, and reconciles retention races', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const firstSession = await createStartedSession(teacher);
    const secondSession = await createStartedSession(teacher);
    for (const session of [firstSession, secondSession]) {
      expect(
        (
          await teacher.agent
            .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
            .set('Origin', TEST_ORIGIN)
            .set(CSRF_HEADER, teacher.csrfToken)
        ).status,
      ).toBe(201);
    }
    const requestFor = async (liveSessionId: string) =>
      teacher.agent
        .post(`/api/v1/results/${liveSessionId}/deletion-requests`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, teacher.csrfToken)
        .send({ reason: 'privacy' });
    const firstRequest = await requestFor(firstSession.liveSessionId);
    const secondRequest = await requestFor(secondSession.liveSessionId);
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    expect(
      (
        await admin.agent
          .post('/api/v1/auth/step-up')
          .set('Origin', TEST_ORIGIN)
          .set(CSRF_HEADER, admin.csrfToken)
          .send({ password: ADMIN.password })
      ).status,
    ).toBe(201);
    const confirmPath = `/api/v1/admin/results/${firstSession.liveSessionId}/deletion`;
    const mismatch = await admin.agent
      .post(confirmPath)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        deletionRequestId: secondRequest.body.data.id,
        confirmed: true,
        reason: 'privacy',
      });
    expect(mismatch.status).toBe(404);

    const body = {
      deletionRequestId: firstRequest.body.data.id,
      confirmed: true,
      reason: 'privacy',
    };
    const deleted = await admin.agent
      .post(confirmPath)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(body);
    const replay = await admin.agent
      .post(confirmPath)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(body);
    expect(deleted.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(deleted.body.data);
    expect(
      await prisma.prisma.deletionEvent.count({
        where: {
          liveSessionId: firstSession.liveSessionId,
          trigger: { in: ['early_delete', 'retention'] },
          status: 'success',
        },
      }),
    ).toBe(1);

    const governance = app.get(GovernanceService);
    const secondArchive = await prisma.prisma.archivedResult.update({
      where: { liveSessionId: secondSession.liveSessionId },
      data: { purgeAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    const raceBody = {
      deletionRequestId: secondRequest.body.data.id,
      confirmed: true,
      reason: 'privacy',
    };
    const outcomes = await Promise.allSettled([
      governance.purgeOne(
        secondSession.liveSessionId,
        'retention',
        undefined,
        'retention',
        new Date(secondArchive.purgeAt.getTime() + 1),
      ),
      admin.agent
        .post(`/api/v1/admin/results/${secondSession.liveSessionId}/deletion`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, admin.csrfToken)
        .send(raceBody),
    ]);
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(
      true,
    );
    const canonical = await prisma.prisma.deletionEvent.findMany({
      where: {
        liveSessionId: secondSession.liveSessionId,
        trigger: { in: ['early_delete', 'retention'] },
        status: 'success',
      },
    });
    expect(canonical).toHaveLength(1);
    expect(['privacy', 'retention']).toContain(canonical[0].reason);
    const resolvedRequest = await prisma.prisma.deletionEvent.findUnique({
      where: { id: secondRequest.body.data.id as string },
    });
    expect(resolvedRequest).toMatchObject({
      status: 'success',
      resolvedByEventId: canonical[0].id,
      completedAt: canonical[0].completedAt,
    });
    expect(
      await prisma.prisma.archivedResult.findUnique({
        where: { liveSessionId: secondSession.liveSessionId },
        select: { status: true, payload: true },
      }),
    ).toEqual({ status: 'deleted', payload: null });
    expect(
      await prisma.prisma.deletionManifestOutbox.count({
        where: { deletionEventId: canonical[0].id },
      }),
    ).toBe(1);

    const canonicalReplay = await admin.agent
      .post(`/api/v1/admin/results/${secondSession.liveSessionId}/deletion`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send(raceBody);
    expect(canonicalReplay.status).toBe(201);
    expect(canonicalReplay.body.data.deletion).toMatchObject({
      trigger: canonical[0].trigger,
      reason: canonical[0].reason,
      deletedAt: canonical[0].completedAt?.toISOString(),
    });
    const conflictingReplay = await admin.agent
      .post(`/api/v1/admin/results/${secondSession.liveSessionId}/deletion`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ ...raceBody, reason: 'support' });
    expect(conflictingReplay.status).toBe(409);
    expectErrorEnvelope(conflictingReplay, 'CONFLICT');
    expect(conflictingReplay.body.error.field).toBe('reason');

    const queue = await admin.agent.get(
      '/api/v1/admin/results/deletion-requests',
    );
    expect(
      queue.body.data.data.some(
        (row: { id: string }) => row.id === secondRequest.body.data.id,
      ),
    ).toBe(false);
  });

  it('purges a bounded oldest-first batch from the database', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      `${TEACHER.username}-bounded`,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const sessions = await Promise.all([
      createStartedSession(teacher),
      createStartedSession(teacher),
      createStartedSession(teacher),
    ]);
    for (const session of sessions) {
      const closed = await teacher.agent
        .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, teacher.csrfToken);
      expect(closed.status).toBe(201);
    }
    const now = new Date('2026-09-09T00:00:00.000Z');
    const archives = await prisma.prisma.archivedResult.findMany({
      where: { liveSessionId: { in: sessions.map((s) => s.liveSessionId) } },
      orderBy: { id: 'asc' },
    });
    expect(archives).toHaveLength(3);
    for (const [index, archive] of archives.entries()) {
      await prisma.prisma.archivedResult.update({
        where: { id: archive.id },
        data: { purgeAt: new Date(now.getTime() - (3 - index) * 1000) },
      });
    }
    const governance = app.get(GovernanceService);
    const firstBatch = await governance.purgeDue(2, now);
    expect(firstBatch).toEqual({ selected: 2, deleted: 2, failed: 0 });
    const firstRemaining = await prisma.prisma.archivedResult.findMany({
      where: { liveSessionId: { in: sessions.map((s) => s.liveSessionId) } },
      orderBy: { purgeAt: 'asc' },
      select: { liveSessionId: true, status: true },
    });
    expect(firstRemaining).toEqual([
      { liveSessionId: sessions[0].liveSessionId, status: 'deleted' },
      { liveSessionId: sessions[1].liveSessionId, status: 'deleted' },
      { liveSessionId: sessions[2].liveSessionId, status: 'active' },
    ]);

    await expect(governance.purgeDue(2, now)).resolves.toEqual({
      selected: 1,
      deleted: 1,
      failed: 0,
    });
    const remaining = await prisma.prisma.archivedResult.findMany({
      where: { liveSessionId: { in: sessions.map((s) => s.liveSessionId) } },
      select: { status: true },
    });
    expect(remaining.every((row) => row.status === 'deleted')).toBe(true);
  });

  it('serializes concurrent purgeDue workers with database row locks', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      `${TEACHER.username}-workers`,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const sessions = await Promise.all([
      createStartedSession(teacher),
      createStartedSession(teacher),
    ]);
    for (const session of sessions) {
      const closed = await teacher.agent
        .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, teacher.csrfToken);
      expect(closed.status).toBe(201);
    }
    const now = new Date('2026-09-09T00:00:00.000Z');
    await prisma.prisma.archivedResult.updateMany({
      where: { liveSessionId: { in: sessions.map((s) => s.liveSessionId) } },
      data: { purgeAt: new Date(now.getTime() - 1) },
    });
    const governance = app.get(GovernanceService);
    const results = await Promise.all([
      governance.purgeDue(2, now),
      governance.purgeDue(2, now),
    ]);
    expect(results.reduce((sum, result) => sum + result.selected, 0)).toBe(2);
    expect(results.reduce((sum, result) => sum + result.deleted, 0)).toBe(2);
    expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
    expect(
      await prisma.prisma.deletionEvent.count({
        where: {
          liveSessionId: { in: sessions.map((s) => s.liveSessionId) },
          trigger: 'retention',
          status: 'success',
        },
      }),
    ).toBe(2);
  });

  it('rejects resurrection by applying a run-scoped deletion manifest idempotently', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      `${TEACHER.username}-no-resurrection`,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const session = await createStartedSession(teacher);
    const joined = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .send({ displayName: 'Manifest participant' });
    expect(joined.status).toBe(201);
    const participantId = joined.body.data.participantId as string;
    const participantToken = joined.body.data.participantToken as string;
    expect(
      (
        await teacher.agent
          .post(
            `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
          )
          .set('Origin', TEST_ORIGIN)
          .set(CSRF_HEADER, teacher.csrfToken)
      ).status,
    ).toBe(201);
    const submitted = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.liveSessionId}/submissions`)
      .set('X-Participant-Token', participantToken)
      .set('Idempotency-Key', newId())
      .send({
        sessionQuestionId: session.sessionQuestionId,
        selectedOptionRefs: ['a'],
      });
    expect(submitted.status).toBe(201);
    expect(
      (
        await teacher.agent
          .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
          .set('Origin', TEST_ORIGIN)
          .set(CSRF_HEADER, teacher.csrfToken)
      ).status,
    ).toBe(201);

    const archive = await prisma.prisma.archivedResult.findUniqueOrThrow({
      where: { liveSessionId: session.liveSessionId },
    });
    const question = await prisma.prisma.sessionQuestion.findUniqueOrThrow({
      where: { id: session.sessionQuestionId },
    });
    const options = await prisma.prisma.sessionQuestionOption.findMany({
      where: { sessionQuestionId: question.id },
      orderBy: { position: 'asc' },
    });
    const participant = await prisma.prisma.participant.findUniqueOrThrow({
      where: { id: participantId },
    });
    const submission = await prisma.prisma.submission.findUniqueOrThrow({
      where: { id: submitted.body.data.id as string },
    });
    const liveSession = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: session.liveSessionId },
      select: { realtimeEventSeq: true },
    });
    const serverEvent = await prisma.prisma.liveSessionEvent.create({
      data: {
        id: newId(),
        liveSessionId: session.liveSessionId,
        sessionQuestionId: question.id,
        targetParticipantId: participant.id,
        eventName: 'result.updated',
        eventSeq: liveSession.realtimeEventSeq + 1n,
        aggregateVersion: question.aggregateVersion,
        visibility: RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
        projectionInput: { sessionQuestionId: question.id },
      },
    });
    const governance = app.get(GovernanceService);
    const purgeNow = new Date('2026-09-09T01:02:03.000Z');
    await prisma.prisma.archivedResult.update({
      where: { id: archive.id },
      data: { purgeAt: new Date('2026-09-09T01:02:02.000Z') },
    });
    const purgeResult = await governance.purgeDue(1, purgeNow);
    expect(purgeResult.failed).toBe(0);
    expect(purgeResult.selected).toBeLessThanOrEqual(1);
    expect(purgeResult.deleted).toBeLessThanOrEqual(1);
    let outbox = await prisma.prisma.deletionManifestOutbox.findUnique({
      where: { archivedResultId: archive.id },
    });
    if (!outbox) {
      await governance.purgeOne(
        session.liveSessionId,
        'retention',
        undefined,
        'retention',
        purgeNow,
      );
      outbox = await prisma.prisma.deletionManifestOutbox.findUniqueOrThrow({
        where: { archivedResultId: archive.id },
      });
    }
    const pendingOutboxCount = await prisma.prisma.deletionManifestOutbox.count(
      {
        where: { archivedResultId: archive.id, status: 'pending' },
      },
    );
    expect(pendingOutboxCount).toBe(1);
    const manifest = outbox.manifest as {
      contractVersion: 'deletion-manifest.v1';
      deletionEventId: string;
      archivedResultId: string;
      liveSessionId: string;
      trigger: 'retention';
      reason: 'retention';
      deletedAt: string;
      categories: string[];
    };
    const deletedAt = new Date(manifest.deletedAt);
    const purgeEvent = await prisma.prisma.deletionEvent.findUniqueOrThrow({
      where: { id: manifest.deletionEventId },
    });
    expect({
      id: purgeEvent.id,
      archivedResultId: purgeEvent.archivedResultId,
      liveSessionId: purgeEvent.liveSessionId,
      trigger: purgeEvent.trigger,
      reason: purgeEvent.reason,
      completedAt: purgeEvent.completedAt?.toISOString(),
      deletedCategories: Array.isArray(purgeEvent.deletedCategories)
        ? [...purgeEvent.deletedCategories].sort()
        : purgeEvent.deletedCategories,
    }).toEqual({
      id: manifest.deletionEventId,
      archivedResultId: manifest.archivedResultId,
      liveSessionId: manifest.liveSessionId,
      trigger: manifest.trigger,
      reason: manifest.reason,
      completedAt: manifest.deletedAt,
      deletedCategories: [...manifest.categories].sort(),
    });

    await prisma.prisma.sessionQuestion.create({ data: question });
    await prisma.prisma.sessionQuestionOption.createMany({ data: options });
    await prisma.prisma.participant.create({ data: participant });
    await prisma.prisma.submission.create({
      data: {
        ...submission,
        selectedOptionRefs:
          submission.selectedOptionRefs === null
            ? Prisma.DbNull
            : (submission.selectedOptionRefs as Prisma.InputJsonValue),
      },
    });
    await prisma.prisma.liveSessionEvent.create({
      data: {
        ...serverEvent,
        projectionInput:
          serverEvent.projectionInput === null
            ? Prisma.DbNull
            : (serverEvent.projectionInput as Prisma.InputJsonValue),
      },
    });

    const applied = await prisma.prisma.$transaction((t) =>
      governance.applyDeletionManifestInTransaction(t, manifest),
    );
    expect(applied.status).toBe('deleted');
    const tombstone = await prisma.prisma.archivedResult.findUniqueOrThrow({
      where: { id: archive.id },
    });
    expect(tombstone.status).toBe('deleted');
    expect(tombstone.payload).toBeNull();
    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.participant.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.sessionQuestion.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.sessionQuestionOption.count({
        where: { sessionQuestionId: question.id },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.liveSessionEvent.count({
        where: {
          liveSessionId: session.liveSessionId,
          visibility: RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
        },
      }),
    ).toBe(0);
    const event = await prisma.prisma.deletionEvent.findUniqueOrThrow({
      where: { id: manifest.deletionEventId },
    });
    expect(event.completedAt?.toISOString()).toBe(deletedAt.toISOString());
    expect(event.id).toBe(manifest.deletionEventId);
    expect(
      await prisma.prisma.deletionManifestOutbox.count({
        where: { archivedResultId: archive.id, status: 'pending' },
      }),
    ).toBe(pendingOutboxCount);
    await expect(
      prisma.prisma.$transaction((t) =>
        governance.applyDeletionManifestInTransaction(t, manifest),
      ),
    ).resolves.toMatchObject({ status: 'deleted' });
    expect(
      await prisma.prisma.deletionEvent.count({
        where: { id: manifest.deletionEventId },
      }),
    ).toBe(1);
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
    const joined = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .send({ displayName: 'Purge participant' });
    expect(joined.status).toBe(201);
    const participantId = joined.body.data.participantId as string;
    const close = await teacher.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(close.status).toBe(201);
    const liveSession = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: session.liveSessionId },
      select: { realtimeEventSeq: true },
    });
    const sessionQuestion =
      await prisma.prisma.sessionQuestion.findUniqueOrThrow({
        where: {
          id: session.sessionQuestionId,
          liveSessionId: session.liveSessionId,
        },
        select: { aggregateVersion: true },
      });
    await prisma.prisma.liveSessionEvent.create({
      data: {
        id: newId(),
        liveSessionId: session.liveSessionId,
        sessionQuestionId: session.sessionQuestionId,
        targetParticipantId: participantId,
        eventName: 'result.updated',
        schemaVersion: 1,
        eventSeq: liveSession.realtimeEventSeq + 1n,
        aggregateVersion: sessionQuestion.aggregateVersion,
        visibility: 'participant_after_submit',
        projectionInput: { sessionQuestionId: session.sessionQuestionId },
      },
    });
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
        archive.purgeAt,
      ),
    ).resolves.toMatchObject({ status: 'deleted' });
    const manifestOutbox =
      await prisma.prisma.deletionManifestOutbox.findUniqueOrThrow({
        where: { archivedResultId: archive.id },
      });
    expect(manifestOutbox).toMatchObject({
      status: 'pending',
      attempts: 0,
      contractVersion: 'deletion-manifest.v1',
    });
    await expect(
      governance.purgeOne(
        session.liveSessionId,
        'retention',
        undefined,
        'retention',
        now,
      ),
    ).resolves.toMatchObject({ status: 'deleted' });
    expect(
      await prisma.prisma.deletionEvent.count({
        where: {
          liveSessionId: session.liveSessionId,
          trigger: 'retention',
          status: 'success',
        },
      }),
    ).toBe(1);
    expect(
      await prisma.prisma.liveSessionEvent.count({
        where: {
          liveSessionId: session.liveSessionId,
          visibility: 'participant_after_submit',
        },
      }),
    ).toBe(0);
  });
});
