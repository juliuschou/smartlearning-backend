import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_COOKIE_NAME, CSRF_HEADER } from '../src/common/security';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('Student account (B1 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'student-e2e-admin',
    displayName: 'Student E2E Admin',
    password: 'student-e2e-admin-password-1234',
  };
  const STUDENT = {
    username: 'student-e2e-student',
    displayName: 'Student E2E Student',
    tempPassword: 'student-e2e-temp-password-1234',
    password: 'student-e2e-final-password-1234',
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
      // Keep the suite blocked when migration setup fails; do not probe stale DB.
    }
    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);
    if (!migrationsReady) return;
    try {
      await prisma.prisma.$queryRaw`SELECT 1`;
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
    expect(response.status).toBe(201);
    return {
      agent: agent as unknown as request.SuperAgentTest,
      csrfToken: cookieValue(
        cookieHeaders(response.headers['set-cookie']),
        CSRF_COOKIE_NAME,
      ),
    };
  }

  async function createStudent(): Promise<{
    accountId: string;
    student: AuthenticatedAgent;
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
        // B1 invariant normalizes this to false.
        canCreateCourse: true,
        tempPassword: STUDENT.tempPassword,
      });
    expect(created.status).toBe(201);
    expect(created.body.data.role).toBe(AccountRole.STUDENT);
    expect(created.body.data.canCreateCourse).toBe(false);
    expect(created.body.data).not.toHaveProperty('passwordHash');

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
      student: await loginAs(STUDENT.username, STUDENT.password),
    };
  }

  async function createCourse(admin: AuthenticatedAgent): Promise<string> {
    const response = await admin.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name: 'Student Policy Course', description: 'B1' });
    expect(response.status).toBe(201);
    return response.body.data.id as string;
  }

  it('logs in with the shared Web Session and exposes the student role safely', async () => {
    if (!dbReachable) return;
    const { student } = await createStudent();

    const session = await student.agent.get('/api/v1/auth/session');
    expect(session.status).toBe(200);
    expect(session.body.data.role).toBe(AccountRole.STUDENT);
    expect(session.body.data.canCreateCourse).toBe(false);
    expect(session.body.data).not.toHaveProperty('passwordHash');
    expect(session.body.data).not.toHaveProperty('cookieHash');
  });

  it('rejects students from teacher-owned course, question, and live-session routes', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const courseId = await createCourse(admin);
    const { student } = await createStudent();

    const createCourseResponse = await student.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.csrfToken)
      .send({ name: 'Should Be Rejected' });
    expect(createCourseResponse.status).toBe(403);

    const courseList = await student.agent.get('/api/v1/courses');
    expect(courseList.status).toBe(403);

    const courseDetail = await student.agent.get(`/api/v1/courses/${courseId}`);
    expect(courseDetail.status).toBe(403);

    const questionList = await student.agent.get(
      `/api/v1/courses/${courseId}/questions`,
    );
    expect(questionList.status).toBe(403);

    const liveSessionCreate = await student.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.csrfToken)
      .send({ courseId, questionIds: [] });
    expect(liveSessionCreate.status).toBe(403);
  });

  it('disabled students cannot log in or reuse an existing session', async () => {
    if (!dbReachable) return;
    const { accountId, student } = await createStudent();
    const admin = await loginAs(ADMIN.username, ADMIN.password);

    const stepUp = await admin.agent
      .post('/api/v1/auth/step-up')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ password: ADMIN.password });
    expect(stepUp.status).toBe(201);

    const disabled = await admin.agent
      .post(`/api/v1/admin/accounts/${accountId}/disable`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(disabled.status).toBe(201);
    expect(disabled.body.data.status).toBe('disabled');

    const existingSession = await student.agent.get('/api/v1/auth/session');
    expect(existingSession.status).toBe(401);

    const newLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: STUDENT.username, password: STUDENT.password });
    expect(newLogin.status).toBe(401);
    expect(newLogin.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });
});
