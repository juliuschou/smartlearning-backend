import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('LiveSession teacher detail (S-2 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'detail-e2e-admin',
    displayName: 'Detail E2E Admin',
    password: 'detail-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'detail-e2e-teacher',
    displayName: 'Detail E2E Teacher',
    tempPassword: 'detail-e2e-temp-password-1234',
    password: 'detail-e2e-final-password-1234',
  };
  const OTHER_TEACHER = {
    username: 'detail-e2e-other-teacher',
    displayName: 'Detail E2E Other Teacher',
    tempPassword: 'detail-e2e-other-temp-1234',
    password: 'detail-e2e-other-final-1234',
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
        'BLOCKED: PostgreSQL migration/schema is unavailable for detail e2e tests.',
      );
    }
  }

  function detailUrl(liveSessionId: string): string {
    return `/api/v1/live-sessions/${liveSessionId}`;
  }

  async function setupWaitingSession(): Promise<{
    teacher: AuthenticatedAgent;
    liveSessionId: string;
    sessionCode: string;
    courseId: string;
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
      .send({ name: 'Detail E2E Course', description: 'detail slice' });
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

    // A waiting session has NOT been started: status is "waiting" and no
    // SessionQuestion snapshot rows exist yet (they are created at start).
    return {
      teacher,
      liveSessionId,
      sessionCode,
      courseId,
    };
  }

  async function setupOpenSession(): Promise<{
    teacher: AuthenticatedAgent;
    liveSessionId: string;
    sessionCode: string;
    sessionQuestionId: string;
    courseId: string;
  }> {
    const ctx = await setupWaitingSession();

    const startResponse = await ctx.teacher.agent
      .post(`/api/v1/live-sessions/${ctx.liveSessionId}/start`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    expect(startResponse.status).toBe(201);
    const sessionQuestionId = startResponse.body.data.sessionQuestions[0]
      .id as string;

    const openResponse = await ctx.teacher.agent
      .post(
        `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    expect(openResponse.status).toBe(201);

    return {
      ...ctx,
      sessionQuestionId,
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

  it('waiting session: joinedCount 0, votedCount 0 (no open question)', async () => {
    requireDatabase();
    const ctx = await setupWaitingSession();

    const detail = await ctx.teacher.agent.get(detailUrl(ctx.liveSessionId));
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe('waiting');
    expect(detail.body.data.joinedCount).toBe(0);
    expect(detail.body.data.votedCount).toBe(0);
    // Full projection present.
    expect(detail.body.data.sessionQuestions).toHaveLength(0);
    expect(detail.body.data.questionSelections).toHaveLength(1);
  });

  it('active session with open question: joined and voted counts (4 joined, 2 voted)', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();

    // 4 participants join; 2 submit on the open question.
    const p1 = await joinParticipant(ctx.sessionCode, 'p1');
    const p2 = await joinParticipant(ctx.sessionCode, 'p2');
    // p3 and p4 join but do not submit; only the count side-effect matters.
    await joinParticipant(ctx.sessionCode, 'p3');
    await joinParticipant(ctx.sessionCode, 'p4');
    await submit(
      ctx.liveSessionId,
      p1.participantToken,
      ctx.sessionQuestionId,
      'a',
      '0190c6b8-0000-7000-8000-000000000801',
    );
    await submit(
      ctx.liveSessionId,
      p2.participantToken,
      ctx.sessionQuestionId,
      'b',
      '0190c6b8-0000-7000-8000-000000000802',
    );

    const detail = await ctx.teacher.agent.get(detailUrl(ctx.liveSessionId));
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe('active');
    expect(detail.body.data.joinedCount).toBe(4);
    expect(detail.body.data.votedCount).toBe(2);
    // Full projection present with the open question.
    expect(detail.body.data.sessionQuestions).toHaveLength(1);
    expect(detail.body.data.sessionQuestions[0].status).toBe('open');
    expect(detail.body.data.questionSelections).toHaveLength(1);
    // Teacher detail never leaks participant identity or token material.
    expect(JSON.stringify(detail.body)).not.toContain('tokenHash');
    expect(JSON.stringify(detail.body)).not.toContain('displayName');
    expect(detail.body.data).not.toHaveProperty('participants');
  });

  it('active session with no open question: votedCount 0, joinedCount reflects participants', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    await joinParticipant(ctx.sessionCode, 'p1');
    await joinParticipant(ctx.sessionCode, 'p2');

    // Close the open question → no question is open.
    const closeResponse = await ctx.teacher.agent
      .post(
        `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/close`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    expect(closeResponse.status).toBe(201);

    const detail = await ctx.teacher.agent.get(detailUrl(ctx.liveSessionId));
    expect(detail.status).toBe(200);
    expect(detail.body.data.joinedCount).toBe(2);
    expect(detail.body.data.votedCount).toBe(0);
    expect(detail.body.data.sessionQuestions[0].status).toBe('closed');
  });

  it('closed session: votedCount 0, joinedCount preserved', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    await joinParticipant(ctx.sessionCode, 'p1');
    await submit(
      ctx.liveSessionId,
      (await joinParticipant(ctx.sessionCode, 'p2')).participantToken,
      ctx.sessionQuestionId,
      'a',
      '0190c6b8-0000-7000-8000-000000000901',
    );

    const closeResponse = await ctx.teacher.agent
      .post(`/api/v1/live-sessions/${ctx.liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    expect(closeResponse.status).toBe(201);

    const detail = await ctx.teacher.agent.get(detailUrl(ctx.liveSessionId));
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe('closed');
    expect(detail.body.data.joinedCount).toBe(2);
    // Session close closes the open question → no open question → voted 0.
    expect(detail.body.data.votedCount).toBe(0);
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

    const detail = await other.agent.get(detailUrl(ctx.liveSessionId));
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe('NOT_FOUND');
  });

  it('unknown liveSessionId returns 404', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    const bogusId = '0190c6b8-0000-7000-8000-000000000999';

    const detail = await ctx.teacher.agent.get(detailUrl(bogusId));
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe('NOT_FOUND');
  });

  it('missing auth (no cookie) returns 401', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();

    const detail = await request(app.getHttpServer()).get(
      detailUrl(ctx.liveSessionId),
    );
    expect(detail.status).toBe(401);
    expect(detail.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET requires no CSRF token (teacher cookie is enough)', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();
    // No X-CSRF-Token header, no Origin — only the session cookie.
    const detail = await ctx.teacher.agent.get(detailUrl(ctx.liveSessionId));
    expect(detail.status).toBe(200);
  });

  it('invalid UUID returns 400', async () => {
    requireDatabase();
    const ctx = await setupOpenSession();

    const detail = await ctx.teacher.agent.get(
      '/api/v1/live-sessions/not-a-uuid',
    );
    expect(detail.status).toBe(400);
  });
});
