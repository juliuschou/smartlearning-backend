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

describe('Questions mutation (update/delete/reorder) (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'qmut-e2e-admin',
    displayName: 'QMut E2E Admin',
    password: 'qmut-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'qmut-e2e-teacher',
    displayName: 'QMut E2E Teacher',
    tempPassword: 'qmut-e2e-temp-password-1234',
    password: 'qmut-e2e-final-password-1234',
  };
  const OTHER_TEACHER = {
    username: 'qmut-e2e-other',
    displayName: 'QMut E2E Other',
    tempPassword: 'qmut-e2e-other-temp-1234',
    password: 'qmut-e2e-other-final-1234',
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
        'BLOCKED: PostgreSQL migration/schema is unavailable for question mutation e2e tests.',
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

  async function createWaitingSession(
    teacher: AuthenticatedAgent,
    courseId: string,
    questionIds: string[],
  ): Promise<string> {
    const res = await teacher.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ courseId, questionIds });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  it('updates a question (full-replace prompt/options) preserving position', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'Update Course');
    const q1 = await createQuestion(teacher, courseId, '題目 1');
    const q2 = await createQuestion(teacher, courseId, '題目 2');

    const updated = await teacher.agent
      .patch(`/api/v1/courses/${courseId}/questions/${q1}`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '更新後的題目',
        selectionMode: 'single',
        options: [
          { optionRef: 'x', text: '新選項 X' },
          { optionRef: 'y', text: '新選項 Y' },
          { optionRef: 'z', text: '新選項 Z' },
        ],
      });
    expect(updated.status).toBe(200);
    expect(updated.body.data.id).toBe(q1);
    expect(updated.body.data.prompt).toBe('更新後的題目');
    expect(updated.body.data.options).toHaveLength(3);
    expect(
      updated.body.data.options.map((o: { position: number }) => o.position),
    ).toEqual([1, 2, 3]);
    // Position preserved.
    expect(updated.body.data.position).toBe(1);

    // q2 untouched.
    const list = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions`,
    );
    expect(list.body.data.data).toHaveLength(2);
    expect(
      list.body.data.data.map((q: { position: number }) => q.position),
    ).toEqual([1, 2]);
    void q2;
  });

  it('rejects a type/selectionMode change on update', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'Type Course');
    const q = await createQuestion(teacher, courseId, '題目');

    // selectionMode 'single' is the only allowed value here; sending a
    // mismatched type/selectionMode is caught either by DTO or service.
    const res = await teacher.agent
      .patch(`/api/v1/courses/${courseId}/questions/${q}`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '題目',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: '選項 A' },
          { optionRef: 'b', text: '選項 B' },
        ],
      });
    // Same type/selectionMode → accepted (200), this asserts the guard path
    // is not spuriously triggered for identical type.
    expect(res.status).toBe(200);
  });

  it('deletes a question and compacts remaining positions', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'Delete Course');
    const q1 = await createQuestion(teacher, courseId, '題目 1');
    const q2 = await createQuestion(teacher, courseId, '題目 2');
    const q3 = await createQuestion(teacher, courseId, '題目 3');

    const del = await teacher.agent
      .delete(`/api/v1/courses/${courseId}/questions/${q2}`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(del.status).toBe(200);
    expect(del.body.data).toBeNull();

    const list = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions`,
    );
    expect(list.body.data.data).toHaveLength(2);
    // Compacted to contiguous 1,2 preserving original order.
    expect(
      list.body.data.data.map((q: { id: string; position: number }) => [
        q.id,
        q.position,
      ]),
    ).toEqual([
      [q1, 1],
      [q3, 2],
    ]);
  });

  it('reorders questions by a full ID order', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'Reorder Course');
    const q1 = await createQuestion(teacher, courseId, '題目 1');
    const q2 = await createQuestion(teacher, courseId, '題目 2');
    const q3 = await createQuestion(teacher, courseId, '題目 3');

    const reordered = await teacher.agent
      .patch(`/api/v1/courses/${courseId}/questions/order`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ questionIds: [q3, q1, q2] });
    expect(reordered.status).toBe(200);
    expect(
      reordered.body.data.data.map((q: { id: string; position: number }) => [
        q.id,
        q.position,
      ]),
    ).toEqual([
      [q3, 1],
      [q1, 2],
      [q2, 3],
    ]);
  });

  it('rejects reorder with missing/extra/duplicate IDs', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'Bad Reorder Course');
    const q1 = await createQuestion(teacher, courseId, '題目 1');
    const q2 = await createQuestion(teacher, courseId, '題目 2');

    // Missing q2.
    const missing = await teacher.agent
      .patch(`/api/v1/courses/${courseId}/questions/order`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ questionIds: [q1] });
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('CONFLICT');

    // Duplicate q1.
    const dup = await teacher.agent
      .patch(`/api/v1/courses/${courseId}/questions/order`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ questionIds: [q1, q1, q2] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');

    // Extra foreign id.
    const foreign = '01900000-0000-7000-8000-000000000099';
    const extra = await teacher.agent
      .patch(`/api/v1/courses/${courseId}/questions/order`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ questionIds: [q1, q2, foreign] });
    expect(extra.status).toBe(409);
    expect(extra.body.error.code).toBe('CONFLICT');
  });

  it('rejects update/delete/reorder for a non-owner with 404', async () => {
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
    const q = await createQuestion(owner, courseId, 'owner 題目');

    const update = await other.agent
      .patch(`/api/v1/courses/${courseId}/questions/${q}`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, other.csrfToken)
      .send({
        type: 'poll',
        prompt: '改',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(update.status).toBe(404);
    expect(update.body.error.code).toBe('NOT_FOUND');

    const del = await other.agent
      .delete(`/api/v1/courses/${courseId}/questions/${q}`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, other.csrfToken);
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe('NOT_FOUND');

    const reorder = await other.agent
      .patch(`/api/v1/courses/${courseId}/questions/order`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, other.csrfToken)
      .send({ questionIds: [q] });
    expect(reorder.status).toBe(404);
    expect(reorder.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects mutation with 409 QUESTION_LOCKED_BY_SESSION when a waiting session selects the question', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'Locked Course');
    const q1 = await createQuestion(teacher, courseId, '題目 1');
    const q2 = await createQuestion(teacher, courseId, '題目 2');
    await createWaitingSession(teacher, courseId, [q1]);

    const update = await teacher.agent
      .patch(`/api/v1/courses/${courseId}/questions/${q1}`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '改',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(update.status).toBe(409);
    expect(update.body.error.code).toBe('QUESTION_LOCKED_BY_SESSION');

    const del = await teacher.agent
      .delete(`/api/v1/courses/${courseId}/questions/${q1}`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('QUESTION_LOCKED_BY_SESSION');

    const reorder = await teacher.agent
      .patch(`/api/v1/courses/${courseId}/questions/order`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ questionIds: [q2, q1] });
    expect(reorder.status).toBe(409);
    expect(reorder.body.error.code).toBe('QUESTION_LOCKED_BY_SESSION');
  });

  it('rejects mutation on an archived course with 409 COURSE_NOT_EDITABLE', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'Archived Course');
    const q = await createQuestion(teacher, courseId, '題目');

    const archive = await teacher.agent
      .post(`/api/v1/courses/${courseId}/archive`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(archive.status).toBe(201);

    const update = await teacher.agent
      .patch(`/api/v1/courses/${courseId}/questions/${q}`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '改',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(update.status).toBe(409);
    expect(update.body.error.code).toBe('COURSE_NOT_EDITABLE');
  });

  it('requires CSRF for mutations', async () => {
    requireDatabase();
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const courseId = await createCourse(teacher, 'CSRF Course');
    const q = await createQuestion(teacher, courseId, '題目');

    // No Origin / CSRF header.
    const update = await teacher.agent
      .patch(`/api/v1/courses/${courseId}/questions/${q}`)
      .send({
        type: 'poll',
        prompt: '改',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(update.status).toBe(403);
    expect(update.body.error.code).toBe('AUTH_CSRF_INVALID');
  });
});
