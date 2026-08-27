import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * Full lifecycle e2e for a poll multiple-choice question: authoring →
 * activate → start → join → submit (multiple selections) → results (per-option
 * counts sum may exceed totalResponses) → close.
 */
describe('Poll multiple-choice live flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'pm-e2e-admin',
    displayName: 'PollMulti E2E Admin',
    password: 'pm-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'pm-e2e-teacher',
    displayName: 'PollMulti E2E Teacher',
    tempPassword: 'pm-e2e-temp-password-1234',
    password: 'pm-e2e-final-password-1234',
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
        'BLOCKED: PostgreSQL migration/schema is unavailable for poll-multiple e2e tests.',
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

  it('runs a poll multiple-choice question through the full classroom lifecycle', async () => {
    requireDatabase();
    const teacher = await createTeacher();

    const courseResponse = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'PollMulti E2E Course', description: 'multiple-choice' });
    expect(courseResponse.status).toBe(201);
    const courseId = courseResponse.body.data.id as string;

    const questionResponse = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '選出你曾使用過的工具（可複選）',
        selectionMode: 'multiple',
        options: [
          { optionRef: 'a', text: '工具 A' },
          { optionRef: 'b', text: '工具 B' },
          { optionRef: 'c', text: '工具 C' },
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
    const snapshotOptions = startResponse.body.data.sessionQuestions[0]
      .options as Array<{ id: string; optionRef: string }>;
    const optionRefs = snapshotOptions.map((o) => o.optionRef);
    expect(optionRefs.sort()).toEqual(['a', 'b', 'c']);

    const openResponse = await teacher.agent
      .post(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(openResponse.status).toBe(201);

    const p1 = await joinParticipant(sessionCode, 'p1');
    // Submit two options (multiple selections).
    const submission = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', p1.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000401')
      .send({
        sessionQuestionId,
        selectedOptionRefs: [optionRefs[0], optionRefs[1]],
      });
    expect(submission.status).toBe(201);
    expect(submission.body.data.selectedOptionRefs).toHaveLength(2);

    const persistedOptions = await prisma.prisma.sessionQuestionOption.findMany(
      {
        where: { sessionQuestionId },
        orderBy: { position: 'asc' },
        select: { id: true, optionRef: true },
      },
    );
    const formalIdsByRef = new Map(
      persistedOptions.map((option) => [option.optionRef, option.id]),
    );
    const persistedSubmission =
      await prisma.prisma.submission.findUniqueOrThrow({
        where: { id: submission.body.data.id as string },
      });
    expect(persistedSubmission.selectedOptionRefs).toEqual([
      formalIdsByRef.get(optionRefs[0]),
      formalIdsByRef.get(optionRefs[1]),
    ]);
    expect(
      (persistedSubmission.selectedOptionRefs as string[]).every((value) =>
        persistedOptions.some((option) => option.id === value),
      ),
    ).toBe(true);

    // Idempotent replay with permuted order → same submission.
    const replay = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', p1.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000401')
      .send({
        sessionQuestionId,
        selectedOptionRefs: [optionRefs[1], optionRefs[0]],
      });
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(submission.body.data.id);
    expect(
      await prisma.prisma.submission.count({
        where: { participantId: p1.participantId, sessionQuestionId },
      }),
    ).toBe(1);

    const p2 = await joinParticipant(sessionCode, 'p2');
    for (const [index, [selectedOptionRefs, expectedCode]] of [
      [[], 'FIELD_REQUIRED'],
      [[optionRefs[0], optionRefs[0]], 'OPTION_REF_INVALID'],
      [
        [optionRefs[0], optionRefs[1], optionRefs[2], optionRefs[0]],
        'OPTION_REF_INVALID',
      ],
    ].entries()) {
      const invalid = await request(app.getHttpServer())
        .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
        .set('X-Participant-Token', p2.participantToken)
        .set('Idempotency-Key', `0190c6b8-0000-7000-8000-00000000041${index}`)
        .send({ sessionQuestionId, selectedOptionRefs });
      expect(invalid.status).toBe(400);
      expect(invalid.body.data).toBeNull();
      expect(invalid.body.error.code).toBe(expectedCode);
    }

    const submission2 = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', p2.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000402')
      .send({ sessionQuestionId, selectedOptionRefs: [optionRefs[0]] });
    expect(submission2.status).toBe(201);

    // Results: multiple selections mean option-count sum > totalResponses.
    const results = await request(app.getHttpServer())
      .get(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/results`,
      )
      .set('X-Participant-Token', p1.participantToken);
    expect(results.status).toBe(200);
    expect(results.body.data.snapshotType).toBe('poll');
    expect(results.body.data.selectionMode).toBe('multiple');
    expect(results.body.data.totalResponses).toBe(2);
    const counts = (
      results.body.data.options as Array<{ optionRef: string; count: number }>
    ).reduce<Record<string, number>>((acc, o) => {
      acc[o.optionRef] = o.count;
      return acc;
    }, {});
    expect(counts.a).toBe(2);
    expect(counts.b).toBe(1);
    expect(counts.c).toBe(0);
    // Poll has no correctness metrics.
    expect(results.body.data).not.toHaveProperty('correctCount');

    const closeQuestion = await teacher.agent
      .post(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/close`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(closeQuestion.status).toBe(201);
    expect(closeQuestion.body.data.status).toBe('closed');

    const persistedQuestion =
      await prisma.prisma.sessionQuestion.findUniqueOrThrow({
        where: { id: sessionQuestionId },
        select: { status: true, closedAt: true },
      });
    expect(persistedQuestion.status).toBe('closed');
    expect(persistedQuestion.closedAt).not.toBeNull();

    const closedResults = await request(app.getHttpServer())
      .get(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/results`,
      )
      .set('X-Participant-Token', p1.participantToken);
    expect(closedResults.status).toBe(200);
    expect(closedResults.body.data.totalResponses).toBe(2);

    const afterCloseSubmission = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', p1.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000403')
      .send({ sessionQuestionId, selectedOptionRefs: [optionRefs[2]] });
    expect(afterCloseSubmission.status).toBe(409);
  });
});
