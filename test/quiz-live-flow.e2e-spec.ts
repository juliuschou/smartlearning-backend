import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * Full lifecycle e2e for the quiz question type: authoring → activate → start
 * → participant join → submit (multi-correct exact-set) → results (vote-to-reveal
 * hides correctness before close, reveals after) → close. Exercises the Phase A
 * activation gate, multi-ref submission, and the A5 reveal privacy gating.
 */
describe('Quiz live flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'quiz-e2e-admin',
    displayName: 'Quiz E2E Admin',
    password: 'quiz-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'quiz-e2e-teacher',
    displayName: 'Quiz E2E Teacher',
    tempPassword: 'quiz-e2e-temp-password-1234',
    password: 'quiz-e2e-final-password-1234',
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
      // Keep the suite blocked when any migration fails.
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
        'BLOCKED: PostgreSQL migration/schema is unavailable for quiz e2e tests.',
      );
    }
  }

  async function joinParticipant(
    sessionCode: string,
    displayName: string,
  ): Promise<{ participantToken: string; participantId: string }> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${sessionCode}/join`)
      .send({ displayName });
    expect(response.status).toBe(201);
    return {
      participantToken: response.body.data.participantToken as string,
      participantId: response.body.data.participantId as string,
    };
  }

  it('runs a quiz question through the full classroom lifecycle with exact-set scoring and reveal gating', async () => {
    requireDatabase();
    const teacher = await createTeacher();

    const courseResponse = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Quiz E2E Course', description: 'multi-correct quiz' });
    expect(courseResponse.status).toBe(201);
    const courseId = courseResponse.body.data.id as string;

    // Quiz with two correct options (exact-set, multi-answer).
    const questionResponse = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'quiz',
        prompt: '下列哪些是質數？',
        options: [
          { optionRef: 'two', text: '2' },
          { optionRef: 'three', text: '3' },
          { optionRef: 'four', text: '4' },
        ],
        correctOptionRefs: ['two', 'three'],
      });
    expect(questionResponse.status).toBe(201);
    const questionId = questionResponse.body.data.id as string;

    // Activation: quiz is now activatable (Phase A gate relaxed).
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

    // Snapshot options preserve optionRef; learner snapshot hides isCorrect.
    const sessionOptions = startResponse.body.data.sessionQuestions[0]
      .options as Array<{ optionRef: string }>;
    expect(sessionOptions.map((o) => o.optionRef).sort()).toEqual([
      'four',
      'three',
      'two',
    ]);
    expect(
      JSON.stringify(startResponse.body.data.sessionQuestions[0]),
    ).not.toContain('isCorrect');

    const openResponse = await teacher.agent
      .post(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(openResponse.status).toBe(201);

    // Two participants: one submits the exact correct set, one submits a wrong set.
    const correct = await joinParticipant(sessionCode, 'correct');
    const wrong = await joinParticipant(sessionCode, 'wrong');

    // Wrong answer first (subset, not exact-set).
    const wrongSubmission = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', wrong.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000201')
      .send({ sessionQuestionId, selectedOptionRefs: ['two'] });
    expect(wrongSubmission.status).toBe(201);

    // Correct answer: exact-set, order-independent on the wire.
    const correctSubmission = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', correct.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000202')
      .send({ sessionQuestionId, selectedOptionRefs: ['three', 'two'] });
    expect(correctSubmission.status).toBe(201);
    expect(correctSubmission.body.data.textAnswer).toBeNull();

    // Idempotent replay: same key, permuted order → same submission (order-independent fingerprint).
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', correct.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000202')
      .send({ sessionQuestionId, selectedOptionRefs: ['two', 'three'] });
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(correctSubmission.body.data.id);

    // Duplicate ref rejected.
    const duplicate = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', wrong.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000203')
      .send({ sessionQuestionId, selectedOptionRefs: ['two', 'two'] });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.code).toBe('OPTION_REF_INVALID');

    // Results while OPEN: participant who submitted sees counts but NOT correctness metrics.
    const openResults = await request(app.getHttpServer())
      .get(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/results`,
      )
      .set('X-Participant-Token', correct.participantToken);
    expect(openResults.status).toBe(200);
    expect(openResults.body.data.snapshotType).toBe('quiz');
    expect(openResults.body.data.totalResponses).toBe(2);
    expect(openResults.body.data).not.toHaveProperty('correctCount');
    expect(openResults.body.data).not.toHaveProperty('correctnessRate');
    // Option-level isCorrect also hidden while open.
    expect(JSON.stringify(openResults.body.data.options)).not.toContain(
      '"isCorrect"',
    );

    // Teacher results while OPEN: full correctness visible.
    const teacherOpenResults = await teacher.agent.get(
      `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/results`,
    );
    expect(teacherOpenResults.status).toBe(200);
    expect(teacherOpenResults.body.data.correctCount).toBe(1);
    expect(teacherOpenResults.body.data.incorrectCount).toBe(1);
    expect(teacherOpenResults.body.data.correctnessRate).toBe(0.5);

    // Participant who has NOT submitted cannot see results while open.
    const unsubmitted = await joinParticipant(sessionCode, 'lurker');
    const blockedResults = await request(app.getHttpServer())
      .get(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/results`,
      )
      .set('X-Participant-Token', unsubmitted.participantToken);
    expect(blockedResults.status).toBe(409);
    expect(blockedResults.body.error.code).toBe('RESULTS_NOT_REVEALED');

    // Close: participant results now reveal correctness.
    const closeResponse = await teacher.agent
      .post(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/close`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(closeResponse.status).toBe(201);

    const closedResults = await request(app.getHttpServer())
      .get(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/results`,
      )
      .set('X-Participant-Token', correct.participantToken);
    expect(closedResults.status).toBe(200);
    expect(closedResults.body.data.correctCount).toBe(1);
    expect(closedResults.body.data.correctnessRate).toBe(0.5);
    // Option-level isCorrect now revealed.
    const revealedOptions = closedResults.body.data.options as Array<{
      isCorrect?: boolean;
    }>;
    expect(revealedOptions.some((o) => o.isCorrect === true)).toBe(true);
  });
});
