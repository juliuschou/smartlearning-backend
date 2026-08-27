import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * Full lifecycle e2e for the open_text question type: authoring → activate →
 * start → participant join → submit (text answer) → results (anonymous text
 * list) → close. Exercises the Phase A activation gate for open_text, the
 * textAnswer submission path, and the open_text results projection.
 */
describe('Open-text live flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'ot-e2e-admin',
    displayName: 'OpenText E2E Admin',
    password: 'ot-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'ot-e2e-teacher',
    displayName: 'OpenText E2E Teacher',
    tempPassword: 'ot-e2e-temp-password-1234',
    password: 'ot-e2e-final-password-1234',
  };
  const STUDENT = {
    username: 'ot-e2e-student',
    displayName: 'OpenText E2E Student',
    tempPassword: 'ot-e2e-student-temp-password-1234',
    password: 'ot-e2e-student-final-password-1234',
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

  async function createStudent(): Promise<{
    accountId: string;
    auth: AuthenticatedAgent;
  }> {
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

    return {
      accountId: created.body.data.id as string,
      auth: await loginAs(STUDENT.username, STUDENT.password),
    };
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for open_text e2e tests.',
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

  it('runs an open_text question through the full classroom lifecycle with text answers', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const student = await createStudent();

    const courseResponse = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'OpenText E2E Course', description: 'open_text slice' });
    expect(courseResponse.status).toBe(201);
    const courseId = courseResponse.body.data.id as string;

    const enrollment = await teacher.agent
      .post(`/api/v1/courses/${courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(enrollment.status).toBe(201);

    const questionResponse = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'open_text',
        prompt: '用一句話描述你今天學到最重要的概念。',
      });
    expect(questionResponse.status).toBe(201);
    const questionId = questionResponse.body.data.id as string;
    expect(questionResponse.body.data.options).toEqual([]);

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

    // Option refs are forbidden for open_text answers, including refs-only
    // payloads and mixed payloads.
    const p1 = await joinParticipant(sessionCode, 'p1');
    const refsOnly = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', p1.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000301')
      .send({ sessionQuestionId, selectedOptionRefs: ['whatever'] });
    expect(refsOnly.status).toBe(400);
    expect(refsOnly.body.error.code).toBe('FIELD_FORBIDDEN');

    const withRefs = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', p1.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000302')
      .send({
        sessionQuestionId,
        selectedOptionRefs: ['whatever'],
        textAnswer: '我的答案',
      });
    expect(withRefs.status).toBe(400);
    expect(withRefs.body.error.code).toBe('FIELD_FORBIDDEN');

    // Valid text answer; response carries the normalized text, no selected refs.
    const submission = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', p1.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000302')
      .send({ sessionQuestionId, textAnswer: '  我 學到了因果關係  ' });
    expect(submission.status).toBe(201);
    expect(submission.body.data.textAnswer).toBe('我 學到了因果關係');
    expect(submission.body.data.selectedOptionRefs).toBeNull();

    const submissionId = submission.body.data.id as string;
    const persistedSubmission =
      await prisma.prisma.submission.findUniqueOrThrow({
        where: { id: submissionId },
        select: { selectedOptionRefs: true, textAnswer: true },
      });
    expect(persistedSubmission.textAnswer).toBe('我 學到了因果關係');
    expect(persistedSubmission.selectedOptionRefs).toBeNull();

    const sqlNullCheck = await prisma.prisma.$queryRaw<
      Array<{ selectedOptionRefsIsNull: boolean; selectedOptionRefs: unknown }>
    >`
      SELECT
        selected_option_refs IS NULL AS "selectedOptionRefsIsNull",
        selected_option_refs AS "selectedOptionRefs"
      FROM submission
      WHERE id = ${submissionId}::uuid
    `;
    expect(sqlNullCheck).toHaveLength(1);
    expect(sqlNullCheck[0].selectedOptionRefsIsNull).toBe(true);
    expect(sqlNullCheck[0].selectedOptionRefs).toBeNull();

    const p2 = await joinParticipant(sessionCode, 'p2');
    const submission2 = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', p2.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000303')
      .send({ sessionQuestionId, textAnswer: '抽樣誤差' });
    expect(submission2.status).toBe(201);

    const studentJoin = await student.auth.agent
      .post(`/api/v1/live-sessions/${sessionCode}/join`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .send({});
    expect(studentJoin.status).toBe(201);
    expect(studentJoin.body.data.participantToken).toBeNull();

    const studentSubmission = await student.auth.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000305')
      .send({ sessionQuestionId, textAnswer: '可觀測性' });
    expect(studentSubmission.status).toBe(201);
    expect(studentSubmission.body.data.textAnswer).toBe('可觀測性');

    function expectAnonymousResults(response: request.Response): void {
      expect(response.status).toBe(200);
      expect(response.body.data.snapshotType).toBe('open_text');
      expect(response.body.data.totalResponses).toBe(3);
      expect(response.body.data.responses).toEqual(
        expect.arrayContaining([
          { text: '我 學到了因果關係' },
          { text: '抽樣誤差' },
          { text: '可觀測性' },
        ]),
      );
      for (const result of response.body.data.responses as Array<
        Record<string, unknown>
      >) {
        expect(Object.keys(result)).toEqual(['text']);
      }
      const serialized = JSON.stringify(response.body.data);
      for (const field of [
        'participantId',
        'accountId',
        'displayName',
        'participantToken',
        'sessionCode',
      ]) {
        expect(serialized).not.toContain(field);
      }
      expect(serialized).not.toContain(student.accountId);
      expect(serialized).not.toContain(STUDENT.displayName);
      expect(serialized).not.toContain(p1.participantToken);
      expect(serialized).not.toContain(p2.participantToken);
    }

    // Results remain anonymous in the open state for the account-bound student.
    const openResults = await student.auth.agent.get(
      `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/results`,
    );
    expectAnonymousResults(openResults);

    // Overlong text (>2000 code points) is rejected.
    const longText = 'x'.repeat(2001);
    const overlong = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', p2.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000304')
      .send({ sessionQuestionId, textAnswer: longText });
    expect(overlong.status).toBe(400);

    const closeResponse = await teacher.agent
      .post(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/close`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(closeResponse.status).toBe(201);

    // Closing must not add identity metadata to either teacher or participant results.
    const teacherResults = await teacher.agent.get(
      `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/results`,
    );
    expectAnonymousResults(teacherResults);

    const closedStudentResults = await student.auth.agent.get(
      `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/results`,
    );
    expectAnonymousResults(closedStudentResults);
  });
});
