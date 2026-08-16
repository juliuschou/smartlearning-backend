import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('Poll single-choice (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'poll-e2e-admin',
    displayName: 'Poll E2E Admin',
    password: 'poll-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'poll-e2e-teacher',
    displayName: 'Poll E2E Teacher',
    tempPassword: 'poll-e2e-temp-password-1234',
    password: 'poll-e2e-final-password-1234',
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

  async function createTeacher(): Promise<AuthenticatedAgent> {
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
    return loginAs(TEACHER.username, TEACHER.password);
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for poll e2e tests.',
      );
    }
  }

  it('executes the Question to LiveSession to Participant to Submission HTTP slice', async () => {
    requireDatabase();
    const teacher = await createTeacher();

    const courseResponse = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Poll E2E Course', description: 'single-choice slice' });
    expect(courseResponse.status).toBe(201);
    expect(courseResponse.body.meta.schemaVersion).toBe(1);
    const courseId = courseResponse.body.data.id as string;

    const questionResponse = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '目前你最想釐清哪一個概念？',
        selectionMode: 'single',
        options: [
          { optionRef: 'source', text: '資料來源' },
          { optionRef: 'bias', text: '樣本偏差' },
          { optionRef: 'causality', text: '因果關係' },
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
    expect(waitingResponse.body.data.status).toBe('waiting');
    const liveSessionId = waitingResponse.body.data.id as string;
    const sessionCode = waitingResponse.body.data.sessionCode as string;

    const startResponse = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/start`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(startResponse.status).toBe(201);
    expect(startResponse.body.data.status).toBe('active');
    const sessionQuestion = startResponse.body.data.sessionQuestions[0];
    const sessionQuestionId = sessionQuestion.id as string;
    expect(sessionQuestion.options[0].optionRef).toBe('source');
    const optionRef = sessionQuestion.options[0].optionRef as string;
    const alternateOptionRef = sessionQuestion.options[1].optionRef as string;

    const openResponse = await teacher.agent
      .post(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(openResponse.status).toBe(201);
    expect(openResponse.body.data.status).toBe('open');

    const joinResponse = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${sessionCode}/join`)
      .send({ displayName: ' 小明 ' });
    expect(joinResponse.status).toBe(201);
    const participantToken = joinResponse.body.data.participantToken as string;
    const participantId = joinResponse.body.data.participantId as string;
    expect(participantToken).toBeTruthy();
    expect(joinResponse.body.data.currentQuestion.id).toBe(sessionQuestionId);

    const snapshotResponse = await request(app.getHttpServer())
      .get(`/api/v1/live-sessions/${liveSessionId}/snapshot`)
      .set('X-Participant-Token', participantToken);
    expect(snapshotResponse.status).toBe(200);
    expect(snapshotResponse.body.data.sessionQuestions[0].hasSubmitted).toBe(
      false,
    );
    expect(
      snapshotResponse.body.data.sessionQuestions[0].options[0].optionRef,
    ).toBe('source');
    expect(JSON.stringify(snapshotResponse.body)).not.toContain(
      'participantToken',
    );

    const idempotencyKey = '0190c6b8-0000-7000-8000-000000000110';
    const submissionResponse = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', participantToken)
      .set('Idempotency-Key', idempotencyKey)
      .send({ sessionQuestionId, selectedOptionRefs: [optionRef] });
    expect(submissionResponse.status).toBe(201);
    expect(submissionResponse.body.data.participantId).toBe(participantId);
    expect(JSON.stringify(submissionResponse.body)).not.toContain(
      participantToken,
    );

    const replayResponse = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', participantToken)
      .set('Idempotency-Key', idempotencyKey)
      .send({ sessionQuestionId, selectedOptionRefs: [optionRef] });
    expect(replayResponse.status).toBe(201);
    expect(replayResponse.body.data.id).toBe(submissionResponse.body.data.id);

    const conflictResponse = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000111')
      .send({
        sessionQuestionId,
        selectedOptionRefs: [alternateOptionRef],
      });
    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.body.error.code).toBe('SUBMISSION_CONFLICT');

    const finalSnapshot = await request(app.getHttpServer())
      .get(`/api/v1/live-sessions/${liveSessionId}/snapshot`)
      .set('X-Participant-Token', participantToken);
    expect(finalSnapshot.status).toBe(200);
    expect(finalSnapshot.body.data.sessionQuestions[0].hasSubmitted).toBe(true);
    expect(JSON.stringify(finalSnapshot.body)).not.toContain(participantToken);
  });
});
