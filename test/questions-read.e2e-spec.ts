import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('Questions read (list/detail) (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'qread-e2e-admin',
    displayName: 'QRead E2E Admin',
    password: 'qread-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'qread-e2e-teacher',
    displayName: 'QRead E2E Teacher',
    tempPassword: 'qread-e2e-temp-password-1234',
    password: 'qread-e2e-final-password-1234',
  };
  const OTHER_TEACHER = {
    username: 'qread-e2e-other',
    displayName: 'QRead E2E Other',
    tempPassword: 'qread-e2e-other-temp-1234',
    password: 'qread-e2e-other-final-1234',
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

  async function createTeacher(
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
      .send({
        currentPassword: tempPassword,
        newPassword: finalPassword,
      });
    expect(changed.status).toBe(201);
    return loginAs(username, finalPassword);
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for question read e2e tests.',
      );
    }
  }

  async function createCourse(
    teacher: AuthenticatedAgent,
    name: string,
  ): Promise<string> {
    const res = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  async function createQuestion(
    teacher: AuthenticatedAgent,
    courseId: string,
    prompt: string,
  ): Promise<string> {
    const res = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt,
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: '選項 A' },
          { optionRef: 'b', text: '選項 B' },
        ],
      });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  it('lists questions ordered by position with pagination meta', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'List Course');
    const ids = await Promise.all([
      createQuestion(teacher, courseId, '題目 1'),
      createQuestion(teacher, courseId, '題目 2'),
      createQuestion(teacher, courseId, '題目 3'),
    ]);

    const list = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions`,
    );
    expect(list.status).toBe(200);
    expect(list.body.data.data).toHaveLength(3);
    // Ordered by position ascending.
    expect(
      list.body.data.data.map((q: { position: number }) => q.position),
    ).toEqual([1, 2, 3]);
    expect(list.body.data.meta.total).toBe(3);
    expect(list.body.data.meta.totalPages).toBe(1);
    expect(list.body.data.meta.page).toBe(1);
    expect(list.body.data.meta.pageSize).toBe(20);
    // Authoring projection exposes isCorrect (false for poll) and correctOptionRefs.
    expect(
      list.body.data.data[0].options.every(
        (o: { isCorrect: boolean }) => o.isCorrect === false,
      ),
    ).toBe(true);
    expect(list.body.data.data[0].correctOptionRefs).toEqual([]);
    void ids;
  });

  it('honors page and pageSize query parameters', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'Paged Course');
    for (let i = 1; i <= 3; i++) {
      await createQuestion(teacher, courseId, `題目 ${i}`);
    }

    const page = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions?page=1&pageSize=2`,
    );
    expect(page.status).toBe(200);
    expect(page.body.data.data).toHaveLength(2);
    expect(page.body.data.meta.total).toBe(3);
    expect(page.body.data.meta.totalPages).toBe(2);
    expect(page.body.data.meta.pageSize).toBe(2);
  });

  it('returns a single question with ordered options and no isCorrect', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'Detail Course');
    const questionId = await createQuestion(teacher, courseId, '詳情題目');

    const detail = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions/${questionId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.id).toBe(questionId);
    expect(detail.body.data.courseId).toBe(courseId);
    expect(detail.body.data.type).toBe('poll');
    expect(detail.body.data.selectionMode).toBe('single');
    expect(detail.body.data.options).toHaveLength(2);
    expect(
      detail.body.data.options.map((o: { position: number }) => o.position),
    ).toEqual([1, 2]);
    // Authoring projection exposes isCorrect (false for poll) and correctOptionRefs.
    expect(
      detail.body.data.options.every(
        (o: { isCorrect: boolean }) => o.isCorrect === false,
      ),
    ).toBe(true);
    expect(detail.body.data.correctOptionRefs).toEqual([]);
  });

  it('rejects list/detail for a non-owner with 404 (no existence leak)', async () => {
    requireDatabase();
    const owner = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const other = await createTeacher(
      OTHER_TEACHER.username,
      OTHER_TEACHER.displayName,
      OTHER_TEACHER.tempPassword,
      OTHER_TEACHER.password,
    );
    const courseId = await createCourse(owner, 'Owner Course');
    const questionId = await createQuestion(owner, courseId, 'owner 題目');

    const list = await other.agent.get(`/api/v1/courses/${courseId}/questions`);
    expect(list.status).toBe(404);
    expect(list.body.error.code).toBe('NOT_FOUND');

    const detail = await other.agent.get(
      `/api/v1/courses/${courseId}/questions/${questionId}`,
    );
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe('NOT_FOUND');
  });

  it('allows an admin to list/detail another owner course questions', async () => {
    requireDatabase();
    const owner = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const courseId = await createCourse(owner, 'Admin Read Course');
    const questionId = await createQuestion(owner, courseId, 'admin 題目');

    const list = await admin.agent.get(`/api/v1/courses/${courseId}/questions`);
    expect(list.status).toBe(200);
    expect(list.body.data.data).toHaveLength(1);

    const detail = await admin.agent.get(
      `/api/v1/courses/${courseId}/questions/${questionId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.id).toBe(questionId);
  });

  it('allows GET without CSRF (safe read)', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'No CSRF Course');
    await createQuestion(teacher, courseId, 'no csrf 題目');

    // No Origin / CSRF header sent — safe GET must still succeed.
    const list = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions`,
    );
    expect(list.status).toBe(200);
  });

  it('returns 404 for a missing question id within an accessible course', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'Missing Q Course');
    const missingId = '01900000-0000-7000-8000-000000000000';

    const detail = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions/${missingId}`,
    );
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for a question id that belongs to another course', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseA = await createCourse(teacher, 'Course A');
    const courseB = await createCourse(teacher, 'Course B');
    const questionA = await createQuestion(teacher, courseA, 'A 題目');

    // questionA exists but is scoped to courseA; asking under courseB → 404.
    const detail = await teacher.agent.get(
      `/api/v1/courses/${courseB}/questions/${questionA}`,
    );
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe('NOT_FOUND');
  });

  it('allows listing/detailing questions of an archived course', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'Archived Course');
    const questionId = await createQuestion(teacher, courseId, 'archived 題目');

    const archive = await teacher.agent
      .post(`/api/v1/courses/${courseId}/archive`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(archive.status).toBe(201);

    const list = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions`,
    );
    expect(list.status).toBe(200);
    expect(list.body.data.data).toHaveLength(1);

    const detail = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions/${questionId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.id).toBe(questionId);
  });
});
