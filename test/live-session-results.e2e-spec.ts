import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('LiveSession question results (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'results-e2e-admin',
    displayName: 'Results E2E Admin',
    password: 'results-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'results-e2e-teacher',
    displayName: 'Results E2E Teacher',
    tempPassword: 'results-e2e-temp-password-1234',
    password: 'results-e2e-final-password-1234',
  };
  const OTHER_TEACHER = {
    username: 'results-e2e-other-teacher',
    displayName: 'Results E2E Other Teacher',
    tempPassword: 'results-e2e-other-temp-1234',
    password: 'results-e2e-other-final-1234',
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

  async function createTeacher(
    username: string,
    displayName: string,
    tempPassword: string,
    password: string,
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
      .send({ currentPassword: tempPassword, newPassword: password });
    expect(changed.status).toBe(201);
    return loginAs(username, password);
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for results e2e tests.',
      );
    }
  }

  /**
   * Bootstraps a course + poll/single question + active session with the
   * question open. Returns handles for teacher + the open question.
   */
  async function setupOpenSession(): Promise<{
    teacher: AuthenticatedAgent;
    liveSessionId: string;
    sessionCode: string;
    sessionQuestionId: string;
    optionRefs: { a: string; b: string; c: string };
  }> {
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );

    const courseResponse = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Results E2E Course', description: 'results slice' });
    expect(courseResponse.status).toBe(201);
    const courseId = courseResponse.body.data.id as string;

    const questionResponse = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '哪一個？',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
          { optionRef: 'c', text: 'C' },
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

    const openResponse = await teacher.agent
      .post(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(openResponse.status).toBe(201);

    return {
      teacher,
      liveSessionId,
      sessionCode,
      sessionQuestionId,
      optionRefs: { a: 'a', b: 'b', c: 'c' },
    };
  }

  async function joinParticipant(
    sessionCode: string,
    displayName: string,
  ): Promise<{ participantToken: string; participantId: string }> {
    const joinResponse = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${sessionCode}/join`)
      .send({ displayName });
    expect(joinResponse.status).toBe(201);
    return {
      participantToken: joinResponse.body.data.participantToken as string,
      participantId: joinResponse.body.data.participantId as string,
    };
  }

  async function submit(
    liveSessionId: string,
    participantToken: string,
    sessionQuestionId: string,
    optionRef: string,
    idempotencyKey: string,
  ): Promise<void> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', participantToken)
      .set('Idempotency-Key', idempotencyKey)
      .send({ sessionQuestionId, selectedOptionRefs: [optionRef] });
    expect(response.status).toBe(201);
  }

  function resultsUrl(
    liveSessionId: string,
    sessionQuestionId: string,
  ): string {
    return `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/results`;
  }

  it('teacher sees per-option counts while the question is open (poll single)', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();

    // 3 participants: 2 select A, 1 selects B.
    const p1 = await joinParticipant(ctx.sessionCode, 'p1');
    const p2 = await joinParticipant(ctx.sessionCode, 'p2');
    const p3 = await joinParticipant(ctx.sessionCode, 'p3');
    await submit(
      ctx.liveSessionId,
      p1.participantToken,
      ctx.sessionQuestionId,
      ctx.optionRefs.a,
      '0190c6b8-0000-7000-8000-000000000201',
    );
    await submit(
      ctx.liveSessionId,
      p2.participantToken,
      ctx.sessionQuestionId,
      ctx.optionRefs.a,
      '0190c6b8-0000-7000-8000-000000000202',
    );
    await submit(
      ctx.liveSessionId,
      p3.participantToken,
      ctx.sessionQuestionId,
      ctx.optionRefs.b,
      '0190c6b8-0000-7000-8000-000000000203',
    );

    const results = await ctx.teacher.agent.get(
      resultsUrl(ctx.liveSessionId, ctx.sessionQuestionId),
    );
    expect(results.status).toBe(200);
    expect(results.body.data).toMatchObject({
      snapshotType: 'poll',
      selectionMode: 'single',
      status: 'open',
      totalResponses: 3,
    });
    const counts = Object.fromEntries(
      results.body.data.options.map(
        (o: { optionRef: string; count: number }) => [o.optionRef, o.count],
      ),
    );
    expect(counts).toEqual({ a: 2, b: 1, c: 0 });
    // Poll never exposes isCorrect.
    expect(
      results.body.data.options.every(
        (o: { isCorrect?: boolean }) => o.isCorrect === undefined,
      ),
    ).toBe(true);
    // Teacher aggregate is anonymous — no participant/displayName linkage.
    expect(JSON.stringify(results.body)).not.toContain('participantId');
    expect(JSON.stringify(results.body)).not.toContain('displayName');
  });

  it('teacher sees counts after the question is closed', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    const p1 = await joinParticipant(ctx.sessionCode, 'p1');
    await submit(
      ctx.liveSessionId,
      p1.participantToken,
      ctx.sessionQuestionId,
      ctx.optionRefs.a,
      '0190c6b8-0000-7000-8000-000000000301',
    );

    const closeResponse = await ctx.teacher.agent
      .post(
        `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/close`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    expect(closeResponse.status).toBe(201);

    const results = await ctx.teacher.agent.get(
      resultsUrl(ctx.liveSessionId, ctx.sessionQuestionId),
    );
    expect(results.status).toBe(200);
    expect(results.body.data.status).toBe('closed');
    expect(results.body.data.totalResponses).toBe(1);
  });

  it('participant who has submitted sees the aggregate while open', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    const p1 = await joinParticipant(ctx.sessionCode, 'p1');
    await submit(
      ctx.liveSessionId,
      p1.participantToken,
      ctx.sessionQuestionId,
      ctx.optionRefs.a,
      '0190c6b8-0000-7000-8000-000000000401',
    );

    const results = await request(app.getHttpServer())
      .get(resultsUrl(ctx.liveSessionId, ctx.sessionQuestionId))
      .set('X-Participant-Token', p1.participantToken);
    expect(results.status).toBe(200);
    expect(results.body.data.totalResponses).toBe(1);
  });

  it('participant who has NOT submitted is blocked by vote-to-reveal while open', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    const p1 = await joinParticipant(ctx.sessionCode, 'p1'); // joins but does not submit

    const results = await request(app.getHttpServer())
      .get(resultsUrl(ctx.liveSessionId, ctx.sessionQuestionId))
      .set('X-Participant-Token', p1.participantToken);
    expect(results.status).toBe(409);
    expect(results.body.error.code).toBe('RESULTS_NOT_REVEALED');
  });

  it('participant sees the aggregate after the question is closed, even without submitting', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    const p1 = await joinParticipant(ctx.sessionCode, 'p1'); // does not submit

    const closeResponse = await ctx.teacher.agent
      .post(
        `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/close`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    expect(closeResponse.status).toBe(201);

    const results = await request(app.getHttpServer())
      .get(resultsUrl(ctx.liveSessionId, ctx.sessionQuestionId))
      .set('X-Participant-Token', p1.participantToken);
    expect(results.status).toBe(200);
    expect(results.body.data.totalResponses).toBe(0);
  });

  it('non-owner teacher gets 404 (no existence leak)', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    const other = await createTeacher(
      OTHER_TEACHER.username,
      OTHER_TEACHER.displayName,
      OTHER_TEACHER.tempPassword,
      OTHER_TEACHER.password,
    );

    const results = await other.agent.get(
      resultsUrl(ctx.liveSessionId, ctx.sessionQuestionId),
    );
    expect(results.status).toBe(404);
    expect(results.body.error.code).toBe('NOT_FOUND');
  });

  it('missing or cross-session sessionQuestionId returns 404', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    const bogusId = '0190c6b8-0000-7000-8000-000000000999';

    const results = await ctx.teacher.agent.get(
      resultsUrl(ctx.liveSessionId, bogusId),
    );
    expect(results.status).toBe(404);
    expect(results.body.error.code).toBe('NOT_FOUND');
  });

  it('not_open question returns 409 SESSION_QUESTION_NOT_OPEN', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    // Start a second session on the same course so the first question can be
    // tested in not_open state — but only one session per course is allowed
    // while waiting/active. Instead, close the current question (closed is
    // allowed) — to test not_open we need a freshly started session whose
    // question has not been opened.
    // Close the active session to free the course, then create + start a new one.
    const closeResponse = await ctx.teacher.agent
      .post(`/api/v1/live-sessions/${ctx.liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    expect(closeResponse.status).toBe(201);

    const courseResponse = await ctx.teacher.agent
      .get('/api/v1/courses')
      .set('Origin', TEST_ORIGIN);
    const courseId = courseResponse.body.data.data[0].id as string;

    const questionResponse = await ctx.teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '另一題？',
        selectionMode: 'single',
        options: [
          { optionRef: 'x', text: 'X' },
          { optionRef: 'y', text: 'Y' },
        ],
      });
    const questionId = questionResponse.body.data.id as string;

    const waitingResponse = await ctx.teacher.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken)
      .send({ courseId, questionIds: [questionId] });
    const newSessionId = waitingResponse.body.data.id as string;

    const startResponse = await ctx.teacher.agent
      .post(`/api/v1/live-sessions/${newSessionId}/start`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    const notOpenQuestionId = startResponse.body.data.sessionQuestions[0]
      .id as string;

    const results = await ctx.teacher.agent.get(
      resultsUrl(newSessionId, notOpenQuestionId),
    );
    expect(results.status).toBe(409);
    expect(results.body.error.code).toBe('SESSION_QUESTION_NOT_OPEN');
  });

  it('non-owner teacher gets 404 (not 409) even for a not_open question (no existence leak via state)', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    // Close the active session to free the course, then create + start a new
    // session with a question left in not_open state.
    const closeResponse = await ctx.teacher.agent
      .post(`/api/v1/live-sessions/${ctx.liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    expect(closeResponse.status).toBe(201);

    const courseResponse = await ctx.teacher.agent
      .get('/api/v1/courses')
      .set('Origin', TEST_ORIGIN);
    const courseId = courseResponse.body.data.data[0].id as string;

    const questionResponse = await ctx.teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '未開題？',
        selectionMode: 'single',
        options: [
          { optionRef: 'x', text: 'X' },
          { optionRef: 'y', text: 'Y' },
        ],
      });
    const questionId = questionResponse.body.data.id as string;

    const waitingResponse = await ctx.teacher.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken)
      .send({ courseId, questionIds: [questionId] });
    const newSessionId = waitingResponse.body.data.id as string;

    const startResponse = await ctx.teacher.agent
      .post(`/api/v1/live-sessions/${newSessionId}/start`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    const notOpenQuestionId = startResponse.body.data.sessionQuestions[0]
      .id as string;

    const other = await createTeacher(
      OTHER_TEACHER.username,
      OTHER_TEACHER.displayName,
      OTHER_TEACHER.tempPassword,
      OTHER_TEACHER.password,
    );

    // Ownership check must precede the status check: a non-owner must not learn
    // the question exists via a state-specific 409.
    const results = await other.agent.get(
      resultsUrl(newSessionId, notOpenQuestionId),
    );
    expect(results.status).toBe(404);
    expect(results.body.error.code).toBe('NOT_FOUND');
  });

  it('GET requires no CSRF token (teacher cookie is enough)', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    // No X-CSRF-Token header, no Origin — only the session cookie.
    const results = await ctx.teacher.agent.get(
      resultsUrl(ctx.liveSessionId, ctx.sessionQuestionId),
    );
    expect(results.status).toBe(200);
  });

  it('missing auth (no cookie, no participant token) returns 401', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();

    const results = await request(app.getHttpServer()).get(
      resultsUrl(ctx.liveSessionId, ctx.sessionQuestionId),
    );
    expect(results.status).toBe(401);
    expect(results.body.error.code).toBe('UNAUTHORIZED');
  });
});
