import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('Questions type expansion (poll multiple / open_text / quiz) (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'qtype-e2e-admin',
    displayName: 'QType E2E Admin',
    password: 'qtype-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'qtype-e2e-teacher',
    displayName: 'QType E2E Teacher',
    tempPassword: 'qtype-e2e-temp-password-1234',
    password: 'qtype-e2e-final-password-1234',
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
        'BLOCKED: PostgreSQL migration/schema is unavailable for question type e2e tests.',
      );
    }
  }

  async function createCourse(teacher: AuthenticatedAgent): Promise<string> {
    const res = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Type Course' });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  it('creates and reads a poll multiple-choice question', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const created = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '複選題',
        selectionMode: 'multiple',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(created.status).toBe(201);
    expect(created.body.data.type).toBe('poll');
    expect(created.body.data.selectionMode).toBe('multiple');
    expect(created.body.data.correctOptionRefs).toEqual([]);
    expect(
      created.body.data.options.every(
        (o: { isCorrect: boolean }) => o.isCorrect === false,
      ),
    ).toBe(true);

    const detail = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions/${created.body.data.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.selectionMode).toBe('multiple');
  });

  it('creates and reads an open_text question with no options', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const created = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ type: 'open_text', prompt: '請申論你的觀點' });
    expect(created.status).toBe(201);
    expect(created.body.data.type).toBe('open_text');
    expect(created.body.data.selectionMode).toBeNull();
    expect(created.body.data.options).toEqual([]);
    expect(created.body.data.correctOptionRefs).toEqual([]);

    const detail = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions/${created.body.data.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.options).toEqual([]);
  });

  it('creates and reads a quiz question exposing correctOptionRefs + isCorrect', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const created = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'quiz',
        prompt: '何者正確？',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
          { optionRef: 'c', text: 'C' },
        ],
        correctOptionRefs: ['a', 'c'],
      });
    expect(created.status).toBe(201);
    expect(created.body.data.type).toBe('quiz');
    expect(created.body.data.selectionMode).toBeNull();
    expect(created.body.data.correctOptionRefs).toEqual(['a', 'c']);
    const correctFlags = created.body.data.options.map(
      (o: { optionRef: string; isCorrect: boolean }) => [
        o.optionRef,
        o.isCorrect,
      ],
    );
    expect(correctFlags).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);

    const detail = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions/${created.body.data.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.correctOptionRefs).toEqual(['a', 'c']);
  });

  it('rejects quiz without correctOptionRefs', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const res = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'quiz',
        prompt: 'p',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(res.status).toBe(400);
  });

  it('rejects correctOptionRefs referencing a nonexistent option', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const res = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'quiz',
        prompt: 'p',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
        correctOptionRefs: ['zzz'],
      });
    expect(res.status).toBe(400);
  });

  it('rejects forbidden fields per type (options on open_text)', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const res = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'open_text',
        prompt: 'p',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(res.status).toBe(400);
  });

  it('updates a quiz question preserving correctness', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const created = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'quiz',
        prompt: '原題',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
        correctOptionRefs: ['a'],
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    const updated = await teacher.agent
      .patch(`/api/v1/courses/${courseId}/questions/${id}`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'quiz',
        prompt: '改題',
        options: [
          { optionRef: 'a', text: 'A2' },
          { optionRef: 'b', text: 'B2' },
        ],
        correctOptionRefs: ['b'],
      });
    expect(updated.status).toBe(200);
    expect(updated.body.data.correctOptionRefs).toEqual(['b']);
    expect(
      updated.body.data.options.map(
        (o: { optionRef: string; isCorrect: boolean }) => [
          o.optionRef,
          o.isCorrect,
        ],
      ),
    ).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('keeps learner snapshot free of isCorrect/correctOptionRefs for a poll session', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    // Only poll/single is activatable in this slice; verify the learner-facing
    // snapshot projection does NOT carry authoring-only fields.
    const q = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: 'p',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(q.status).toBe(201);
    const questionId = q.body.data.id as string;

    const session = await teacher.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ courseId, questionIds: [questionId] });
    expect(session.status).toBe(201);
    const liveSessionId = session.body.data.id as string;
    const sessionCode = session.body.data.sessionCode as string;

    const started = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/start`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(started.status).toBe(201);
    const sessionQuestionId = started.body.data.sessionQuestions[0]
      .id as string;

    await teacher.agent
      .post(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);

    const joined = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${sessionCode}/join`)
      .send({ displayName: '學員' });
    expect(joined.status).toBe(201);
    const participantToken = joined.body.data.participantToken as string;

    const snapshot = await request(app.getHttpServer())
      .get(`/api/v1/live-sessions/${liveSessionId}/snapshot`)
      .set('X-Participant-Token', participantToken);
    expect(snapshot.status).toBe(200);
    const sq = snapshot.body.data.sessionQuestions[0];
    // Learner projection must NOT expose correctness.
    expect(
      sq.options.every((o: Record<string, unknown>) => !('isCorrect' in o)),
    ).toBe(true);
    expect(JSON.stringify(sq)).not.toContain('correctOptionRefs');
  });
});
