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

  async function createWaitingSession(teacher: AuthenticatedAgent): Promise<{
    courseId: string;
    liveSessionId: string;
    sessionCode: string;
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
    return {
      courseId,
      liveSessionId: waitingResponse.body.data.id as string,
      sessionCode: waitingResponse.body.data.sessionCode as string,
    };
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

  /**
   * Pre-create a conflicting manifest outbox for the archive so the executor's
   * final outbox `create` violates the `archived_result_id` unique constraint
   * AFTER the governed deletes. The outbox FK requires a real DeletionEvent row.
   */
  async function seedConflictingOutbox(archive: {
    id: string;
    liveSessionId: string;
    courseId: string;
  }): Promise<void> {
    const event = await prisma.prisma.deletionEvent.create({
      data: {
        id: newId(),
        archivedResultId: archive.id,
        liveSessionId: archive.liveSessionId,
        courseId: archive.courseId,
        trigger: 'teacher_request',
        status: 'requested',
      },
    });
    await prisma.prisma.deletionManifestOutbox.create({
      data: {
        id: newId(),
        archivedResultId: archive.id,
        deletionEventId: event.id,
        contractVersion: 'deletion-manifest.v1',
        manifest: { contractVersion: 'deletion-manifest.v1' },
      },
    });
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for close/cancel e2e tests.',
      );
    }
  }

  it('does not archive a waiting session or mutate its lifecycle', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const session = await createWaitingSession(teacher);
    const governance = app.get(GovernanceService);

    await expect(
      governance.archiveSession(session.liveSessionId),
    ).resolves.toBe(null);
    expect(
      await prisma.prisma.archivedResult.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    await expect(
      prisma.prisma.liveSession.findUniqueOrThrow({
        where: { id: session.liveSessionId },
        select: { status: true, closedAt: true },
      }),
    ).resolves.toEqual({ status: 'waiting', closedAt: null });
  });

  it('does not archive an active session or anonymize participants', async () => {
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
      .send({ displayName: 'Active participant' });
    expect(joined.status).toBe(201);
    const participantId = joined.body.data.participantId as string;
    const before = await prisma.prisma.participant.findUniqueOrThrow({
      where: { id: participantId },
      select: { accountId: true, displayName: true, tokenHash: true },
    });
    const governance = app.get(GovernanceService);

    await expect(
      governance.archiveSession(session.liveSessionId),
    ).resolves.toBe(null);
    expect(
      await prisma.prisma.archivedResult.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    await expect(
      prisma.prisma.liveSession.findUniqueOrThrow({
        where: { id: session.liveSessionId },
        select: { status: true, closedAt: true },
      }),
    ).resolves.toEqual({ status: 'active', closedAt: null });
    await expect(
      prisma.prisma.participant.findUniqueOrThrow({
        where: { id: participantId },
        select: { accountId: true, displayName: true, tokenHash: true },
      }),
    ).resolves.toEqual(before);
  });

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
    const firstClosedAt = new Date('2026-09-08T10:00:00.000Z');
    const secondClosedAt = firstClosedAt;
    const foreignClosedAt = new Date('2026-09-08T12:00:00.000Z');
    await prisma.prisma.archivedResult.update({
      where: { liveSessionId: first.liveSessionId },
      data: { closedAt: firstClosedAt },
    });
    await prisma.prisma.archivedResult.update({
      where: { liveSessionId: second.liveSessionId },
      data: { closedAt: secondClosedAt },
    });
    await prisma.prisma.archivedResult.update({
      where: { liveSessionId: foreign.liveSessionId },
      data: { closedAt: foreignClosedAt },
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
    expect(page.body.data.data.map((row: { id: string }) => row.id)).toEqual(
      [...page.body.data.data.map((row: { id: string }) => row.id)]
        .sort()
        .reverse(),
    );

    const byLiveSession = await teacher.agent
      .get('/api/v1/results')
      .query({ liveSessionId: first.liveSessionId });
    expect(byLiveSession.status).toBe(200);
    expect(byLiveSession.body.data).toMatchObject({
      meta: { total: 1, totalPages: 1 },
    });
    expect(byLiveSession.body.data.data[0].liveSessionId).toBe(
      first.liveSessionId,
    );

    const foreignLiveSession = await teacher.agent
      .get('/api/v1/results')
      .query({ liveSessionId: foreign.liveSessionId });
    expect(foreignLiveSession.status).toBe(200);
    expect(foreignLiveSession.body.data).toMatchObject({
      data: [],
      meta: { total: 0, totalPages: 0 },
    });

    const fromBoundary = await teacher.agent
      .get('/api/v1/results')
      .query({ closedFrom: firstClosedAt.toISOString() });
    expect(fromBoundary.status).toBe(200);
    expect(fromBoundary.body.data.meta.total).toBe(2);

    const toBoundary = await teacher.agent
      .get('/api/v1/results')
      .query({ closedTo: secondClosedAt.toISOString() });
    expect(toBoundary.status).toBe(200);
    expect(toBoundary.body.data.meta.total).toBe(2);

    const exactRange = await teacher.agent.get('/api/v1/results').query({
      closedFrom: '2026-09-08T18:00:00.000+08:00',
      closedTo: secondClosedAt.toISOString(),
    });
    expect(exactRange.status).toBe(200);
    expect(exactRange.body.data).toMatchObject({
      meta: { total: 2, totalPages: 1 },
    });

    const combined = await teacher.agent.get('/api/v1/results').query({
      courseId: second.courseId,
      liveSessionId: second.liveSessionId,
      status: 'active',
      closedFrom: firstClosedAt.toISOString(),
      closedTo: secondClosedAt.toISOString(),
      page: 1,
      pageSize: 1,
    });
    expect(combined.status).toBe(200);
    expect(combined.body.data).toMatchObject({
      meta: { page: 1, pageSize: 1, total: 1, totalPages: 1 },
    });
    expect(combined.body.data.data[0].liveSessionId).toBe(second.liveSessionId);

    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const adminForeignLiveSession = await admin.agent
      .get('/api/v1/results')
      .query({ liveSessionId: foreign.liveSessionId });
    expect(adminForeignLiveSession.status).toBe(200);
    expect(adminForeignLiveSession.body.data).toMatchObject({
      meta: { total: 1, totalPages: 1 },
    });

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
      { liveSessionId: 'not-a-uuid' },
      { closedFrom: 'not-a-date' },
      { closedTo: 'not-a-date' },
      { closedFrom: '2026-09-08' },
      { closedTo: '2026-09-08T10:00:00' },
      { status: 'unknown' },
      { unexpected: 'field' },
    ]) {
      const response = await teacher.agent.get('/api/v1/results').query(query);
      expect(response.status).toBe(400);
      expectErrorEnvelope(response, 'VALIDATION_FAILED');
    }

    const reversed = await teacher.agent.get('/api/v1/results').query({
      closedFrom: '2026-09-09T00:00:00.000Z',
      closedTo: '2026-09-08T00:00:00.000Z',
    });
    expect(reversed.status).toBe(400);
    expectErrorEnvelope(reversed, 'VALIDATION_FAILED');
    expect(reversed.body.error.field).toBe('closedTo');

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
    // Serialized fixture setup (see the concurrent-purge test for the reason):
    // racing createStartedSession over one agent's keep-alive socket resets it.
    const sessions = [
      await createStartedSession(teacher),
      await createStartedSession(teacher),
      await createStartedSession(teacher),
    ];
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
    // Fixture setup is serialized: two createStartedSession calls each issue a
    // chain of ~7 authenticated HTTP requests over the same supertest agent's
    // keep-alive socket, and racing them via Promise.all intermittently resets
    // that socket (ECONNRESET on the ephemeral listener port) before any purge
    // work runs. The claim/lease concurrency under test is the concurrent
    // purgeDue below, which stays concurrent.
    const sessions = [
      await createStartedSession(teacher),
      await createStartedSession(teacher),
    ];
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

  it('runs a write-free dry-run whose per-table counts match a real purge', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      `${TEACHER.username}-dryrun`,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    // One session with a participant + submission + events of mixed visibility.
    const session = await createStartedSession(teacher);
    const joined = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .send({ displayName: 'Dry-run participant' });
    expect(joined.status).toBe(201);
    const participantId = joined.body.data.participantId as string;
    const participantToken = joined.body.data.participantToken as string;
    await teacher.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    const submitted = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.liveSessionId}/submissions`)
      .set('X-Participant-Token', participantToken)
      .set('Idempotency-Key', newId())
      .send({
        sessionQuestionId: session.sessionQuestionId,
        selectedOptionRefs: ['a'],
      });
    expect(submitted.status).toBe(201);
    await teacher.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);

    const archive = await prisma.prisma.archivedResult.findUniqueOrThrow({
      where: { liveSessionId: session.liveSessionId },
    });
    const liveSession = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: session.liveSessionId },
      select: { realtimeEventSeq: true },
    });
    const sessionQuestion =
      await prisma.prisma.sessionQuestion.findUniqueOrThrow({
        where: { id: session.sessionQuestionId },
      });
    // Two out-of-band events: one teacher-scoped and one participant-after-submit.
    // Checkpoint D widens the delete scope to ALL session events, so the dry-run
    // must count both and a real purge removes both. The DB CHECK ties
    // target_participant_id non-null only to participant_after_submit, so the
    // teacher event carries no target.
    await prisma.prisma.liveSessionEvent.create({
      data: {
        id: newId(),
        liveSessionId: session.liveSessionId,
        sessionQuestionId: sessionQuestion.id,
        eventName: 'result.updated',
        eventSeq: liveSession.realtimeEventSeq + 1n,
        aggregateVersion: sessionQuestion.aggregateVersion,
        visibility: 'teacher',
        projectionInput: { sessionQuestionId: sessionQuestion.id },
      },
    });
    await prisma.prisma.liveSessionEvent.create({
      data: {
        id: newId(),
        liveSessionId: session.liveSessionId,
        sessionQuestionId: sessionQuestion.id,
        targetParticipantId: participantId,
        eventName: 'result.updated',
        eventSeq: liveSession.realtimeEventSeq + 2n,
        aggregateVersion: sessionQuestion.aggregateVersion,
        visibility: 'participant_after_submit',
        projectionInput: { sessionQuestionId: sessionQuestion.id },
      },
    });

    const governance = app.get(GovernanceService);
    const now = new Date(archive.purgeAt.getTime() + 1);
    const baseline = {
      submissions: await prisma.prisma.submission.count({
        where: { liveSessionId: session.liveSessionId },
      }),
      eventsAll: await prisma.prisma.liveSessionEvent.count({
        where: { liveSessionId: session.liveSessionId },
      }),
      options: await prisma.prisma.sessionQuestionOption.count({
        where: { sessionQuestion: { liveSessionId: session.liveSessionId } },
      }),
      questions: await prisma.prisma.sessionQuestion.count({
        where: { liveSessionId: session.liveSessionId },
      }),
      participants: await prisma.prisma.participant.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    };
    expect(baseline).toMatchObject({
      submissions: 1,
      questions: 1,
      participants: 1,
    });
    expect(baseline.options).toBeGreaterThan(0);
    // The realtime flow writes at least one event; the teacher (out-of-band) row we
    // added plus the natural participant_after_submit event guarantees a non-zero
    // full-scope count that Checkpoint D's widened executor must remove entirely.
    expect(baseline.eventsAll).toBeGreaterThanOrEqual(1);

    const dryRun = await governance.purgeDue(1, now, true);
    expect(dryRun.deleted).toBe(0);
    expect(dryRun.selected).toBe(1);
    expect(dryRun.failed).toBe(0);
    expect(dryRun.planned).toHaveLength(1);
    const plan = dryRun.planned![0];
    expect(plan.archiveId).toBe(archive.id);
    expect(plan.category).toBe('governed_deletion');
    expect(plan.tableCounts).toMatchObject({
      Submission: baseline.submissions,
      LiveSessionEvent: baseline.eventsAll,
      SessionQuestionOption: baseline.options,
      SessionQuestion: baseline.questions,
      Participant: baseline.participants,
    });

    // Zero writes: dry-run leaves every governed row + archive untouched.
    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(baseline.submissions);
    expect(
      await prisma.prisma.liveSessionEvent.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(baseline.eventsAll);
    expect(
      await prisma.prisma.sessionQuestionOption.count({
        where: { sessionQuestion: { liveSessionId: session.liveSessionId } },
      }),
    ).toBe(baseline.options);
    expect(
      await prisma.prisma.sessionQuestion.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(baseline.questions);
    expect(
      await prisma.prisma.participant.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(baseline.participants);
    expect(
      await prisma.prisma.archivedResult.findUniqueOrThrow({
        where: { id: archive.id },
        select: { status: true },
      }),
    ).toMatchObject({ status: 'active' });

    // Execution equivalence: a real purge on the same fixture deletes exactly the
    // rows the dry-run planned (current executor scope), and no more. purgeOne is
    // the deterministic single-session path the executor drives via
    // purgeOneInTransaction (purgeDue may skip a row the realtime publisher keeps
    // briefly locked, so it is not used for the count-equivalence assertion here).
    const purgeResult = await governance.purgeOne(
      session.liveSessionId,
      'retention',
      undefined,
      'retention',
      now,
    );
    expect(purgeResult).toMatchObject({ status: 'deleted' });
    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    // Checkpoint D widens the executor to delete ALL session events
    // (routing/projection/replay/delivery), so every visibility is now removed.
    expect(
      await prisma.prisma.liveSessionEvent.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.sessionQuestionOption.count({
        where: { sessionQuestion: { liveSessionId: session.liveSessionId } },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.sessionQuestion.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.participant.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.archivedResult.findUniqueOrThrow({
        where: { id: archive.id },
        select: { status: true },
      }),
    ).toMatchObject({ status: 'deleted' });
  });

  it('reclaims an expired processing lease and purges exactly once', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      `${TEACHER.username}-lease`,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const session = await createStartedSession(teacher);
    const joined = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .send({ displayName: 'Lease participant' });
    expect(joined.status).toBe(201);
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
    const now = new Date(archive.purgeAt.getTime() + 1);
    // Simulate a crashed worker that claimed the row then died: expired lease,
    // state stuck at processing. The next sweep must reclaim and delete it.
    await prisma.prisma.archivedResult.update({
      where: { id: archive.id },
      data: {
        purgeState: 'processing',
        purgeLeaseToken: newId(),
        purgeLeaseExpiresAt: new Date(now.getTime() - 1),
        purgeAttempts: 1,
      },
    });
    const governance = app.get(GovernanceService);
    // Quiesce the realtime publisher so it does not hold the live_session row lock
    // during the claim; otherwise SKIP LOCKED may skip the single due row.
    const run = await withQuiescedLiveSessionPublisher(app, () =>
      governance.purgeDue(1, now),
    );
    expect(run.deleted).toBe(1);
    expect(run.failed).toBe(0);
    expect(
      await prisma.prisma.archivedResult.findUniqueOrThrow({
        where: { id: archive.id },
      }),
    ).toMatchObject({ status: 'deleted', purgeState: 'deleted' });
    // Exactly one canonical retention tombstone.
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

  it('rolls back the whole item when outbox creation fails mid-transaction', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      `${TEACHER.username}-rollback`,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const session = await createStartedSession(teacher);
    const joined = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .send({ displayName: 'Rollback participant' });
    expect(joined.status).toBe(201);
    const participantToken = joined.body.data.participantToken as string;
    await teacher.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.liveSessionId}/submissions`)
      .set('X-Participant-Token', participantToken)
      .set('Idempotency-Key', newId())
      .send({
        sessionQuestionId: session.sessionQuestionId,
        selectedOptionRefs: ['a'],
      });
    await teacher.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);

    const archive = await prisma.prisma.archivedResult.findUniqueOrThrow({
      where: { liveSessionId: session.liveSessionId },
    });
    const now = new Date(archive.purgeAt.getTime() + 1);
    // Pre-create a conflicting outbox for the SAME archive so the executor's final
    // outbox `create` violates `deletion_manifest_outbox.archived_result_id` unique
    // constraint AFTER the governed deletes. The whole transaction must roll back.
    await seedConflictingOutbox(archive);

    const governance = app.get(GovernanceService);
    await withQuiescedLiveSessionPublisher(app, async () => {
      // Retention purge reaches finalizePurgeInTransaction directly (no teacher
      // request needed), so it exercises the governed deletes then fails on the
      // unique outbox constraint mid-transaction. Must roll back atomically.
      await expect(
        governance.purgeOne(
          session.liveSessionId,
          'retention',
          undefined,
          'retention',
          now,
        ),
      ).rejects.toBeTruthy();
    });

    // Atomicity: every governed row is intact and the archive is still active.
    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(1);
    expect(
      await prisma.prisma.participant.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(1);
    expect(
      await prisma.prisma.sessionQuestionOption.count({
        where: { sessionQuestion: { liveSessionId: session.liveSessionId } },
      }),
    ).toBeGreaterThan(0);
    expect(
      await prisma.prisma.liveSessionEvent.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBeGreaterThan(0);
    expect(
      await prisma.prisma.archivedResult.findUniqueOrThrow({
        where: { id: archive.id },
        select: { status: true, purgeAt: true },
      }),
    ).toMatchObject({ status: 'active' });
    // No successful retention tombstone was committed (the seeded teacher_request
    // event remains, but the governed retention deletion rolled back).
    expect(
      await prisma.prisma.deletionEvent.count({
        where: {
          liveSessionId: session.liveSessionId,
          trigger: 'retention',
          status: 'success',
        },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.deletionManifestOutbox.count({
        where: { archivedResultId: archive.id },
      }),
    ).toBe(1);
  });

  it('does not double-process a single due row across two workers', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      `${TEACHER.username}-same-row`,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const session = await createStartedSession(teacher);
    const joined = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .send({ displayName: 'Same-row participant' });
    expect(joined.status).toBe(201);
    await teacher.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    const archive = await prisma.prisma.archivedResult.findUniqueOrThrow({
      where: { liveSessionId: session.liveSessionId },
    });
    const now = new Date(archive.purgeAt.getTime() + 1);
    const governance = app.get(GovernanceService);

    const [first, second] = await withQuiescedLiveSessionPublisher(app, () =>
      Promise.all([governance.purgeDue(1, now), governance.purgeDue(1, now)]),
    );
    // Exactly one worker deletes the single due row; the other claims nothing
    // (lease already taken/skipped via SKIP LOCKED). No double deletion.
    expect(first.deleted + second.deleted).toBe(1);
    expect(
      await prisma.prisma.archivedResult.findUniqueOrThrow({
        where: { id: archive.id },
      }),
    ).toMatchObject({ status: 'deleted', purgeState: 'deleted' });
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
      await prisma.prisma.deletionManifestOutbox.count({
        where: { archivedResultId: archive.id },
      }),
    ).toBe(1);
  });

  it('quarantines a poison row while clean later-due rows continue', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      `${TEACHER.username}-poison`,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    // Poison archive A (earlier purgeAt) + clean archive B (later purgeAt).
    const create = async (displayName: string) => {
      const session = await createStartedSession(teacher);
      await request(app.getHttpServer())
        .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
        .send({ displayName });
      await teacher.agent
        .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, teacher.csrfToken);
      return prisma.prisma.archivedResult.findUniqueOrThrow({
        where: { liveSessionId: session.liveSessionId },
      });
    };
    const archiveA = await create('Poison participant A');
    const archiveB = await create('Poison participant B');
    const governance = app.get(GovernanceService);
    const now = new Date(
      Math.max(archiveA.purgeAt.getTime(), archiveB.purgeAt.getTime()) + 1,
    );
    // Force archive A to fail permanently by pre-creating a conflicting outbox so
    // the executor's final outbox create violates the unique constraint. Give it a
    // max attempt budget that is already exhausted, so it quarantines immediately.
    await seedConflictingOutbox(archiveA);
    await prisma.prisma.archivedResult.update({
      where: { id: archiveA.id },
      data: { purgeAttempts: 5 },
    });

    const run = await withQuiescedLiveSessionPublisher(app, () =>
      governance.purgeDue(100, now),
    );
    // Head-of-line freedom: B purges despite A failing; A lands in quarantine and
    // no longer blocks the batch. Because A's earlier purgeAt is claimed first,
    // one item fails (quarantined) and B still deletes.
    expect(run.deleted).toBe(1);
    expect(run.failed).toBe(1);
    const stateA = await prisma.prisma.archivedResult.findUniqueOrThrow({
      where: { id: archiveA.id },
    });
    expect(stateA.status).toBe('active');
    expect(stateA.purgeState).toBe('quarantined');
    expect(
      await prisma.prisma.archivedResult.findUniqueOrThrow({
        where: { id: archiveB.id },
      }),
    ).toMatchObject({ status: 'deleted', purgeState: 'deleted' });
  });

  it('leaves all governed tables at zero with exactly one tombstone and one outbox', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      `${TEACHER.username}-comprehensive`,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const session = await createStartedSession(teacher);
    const joined = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .send({ displayName: 'Comprehensive participant' });
    expect(joined.status).toBe(201);
    const participantToken = joined.body.data.participantToken as string;
    await teacher.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.liveSessionId}/submissions`)
      .set('X-Participant-Token', participantToken)
      .set('Idempotency-Key', newId())
      .send({
        sessionQuestionId: session.sessionQuestionId,
        selectedOptionRefs: ['a'],
      });
    await teacher.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    const sessionQuestion =
      await prisma.prisma.sessionQuestion.findUniqueOrThrow({
        where: { id: session.sessionQuestionId },
      });
    const liveSession = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: session.liveSessionId },
      select: { realtimeEventSeq: true },
    });
    // Guarantee a routing/aggregate event with teacher visibility (not
    // participant_after_submit) so the full-session event scope is exercised.
    await prisma.prisma.liveSessionEvent.create({
      data: {
        id: newId(),
        liveSessionId: session.liveSessionId,
        sessionQuestionId: session.sessionQuestionId,
        eventName: 'question.closed',
        schemaVersion: 1,
        eventSeq: liveSession.realtimeEventSeq + 1n,
        aggregateVersion: sessionQuestion.aggregateVersion,
        visibility: 'teacher',
        projectionInput: { sessionQuestionId: session.sessionQuestionId },
      },
    });
    const archive = await prisma.prisma.archivedResult.findUniqueOrThrow({
      where: { liveSessionId: session.liveSessionId },
    });
    const governance = app.get(GovernanceService);
    const now = new Date(archive.purgeAt.getTime() + 1);

    await withQuiescedLiveSessionPublisher(app, () =>
      governance.purgeDue(100, now).then((r) => expect(r.deleted).toBe(1)),
    );

    // All five governed tables → zero.
    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.liveSessionEvent.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.sessionQuestionOption.count({
        where: { sessionQuestion: { liveSessionId: session.liveSessionId } },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.sessionQuestion.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.participant.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.archivedResult.findUniqueOrThrow({
        where: { id: archive.id },
        select: { status: true, purgeState: true },
      }),
    ).toMatchObject({ status: 'deleted', purgeState: 'deleted' });
    // Exactly one canonical retention tombstone and one outbox.
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
      await prisma.prisma.deletionManifestOutbox.count({
        where: { archivedResultId: archive.id },
      }),
    ).toBe(1);
  });
});
