import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CSRF_COOKIE_NAME, CSRF_HEADER } from '../src/common/security';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('Course enrollments (B2 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'enrollment-e2e-admin',
    displayName: 'Enrollment E2E Admin',
    password: 'enrollment-e2e-admin-password-1234',
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
      // Do not probe an existing schema when migration setup failed.
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

  async function createAccount(
    admin: AuthenticatedAgent,
    input: {
      username: string;
      displayName: string;
      role: AccountRole;
      tempPassword: string;
    },
  ): Promise<string> {
    const response = await admin.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        ...input,
        canCreateCourse: input.role === AccountRole.TEACHER,
      });
    expect(response.status).toBe(201);
    expect(response.body.data.role).toBe(input.role);
    return response.body.data.id as string;
  }

  async function createTeacher(admin: AuthenticatedAgent): Promise<{
    accountId: string;
    auth: AuthenticatedAgent;
  }> {
    const accountId = await createAccount(admin, {
      username: 'enrollment-e2e-teacher',
      displayName: 'Enrollment E2E Teacher',
      role: AccountRole.TEACHER,
      tempPassword: 'enrollment-e2e-teacher-temp-1234',
    });
    const temporary = await loginAs(
      'enrollment-e2e-teacher',
      'enrollment-e2e-teacher-temp-1234',
    );
    const changed = await temporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, temporary.csrfToken)
      .send({
        currentPassword: 'enrollment-e2e-teacher-temp-1234',
        newPassword: 'enrollment-e2e-teacher-final-1234',
      });
    expect(changed.status).toBe(201);
    return {
      accountId,
      auth: await loginAs(
        'enrollment-e2e-teacher',
        'enrollment-e2e-teacher-final-1234',
      ),
    };
  }

  async function createStudent(admin: AuthenticatedAgent): Promise<{
    accountId: string;
    auth: AuthenticatedAgent;
  }> {
    const accountId = await createAccount(admin, {
      username: 'enrollment-e2e-student',
      displayName: 'Enrollment E2E Student',
      role: AccountRole.STUDENT,
      tempPassword: 'enrollment-e2e-student-temp-1234',
    });
    const temporary = await loginAs(
      'enrollment-e2e-student',
      'enrollment-e2e-student-temp-1234',
    );
    const changed = await temporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, temporary.csrfToken)
      .send({
        currentPassword: 'enrollment-e2e-student-temp-1234',
        newPassword: 'enrollment-e2e-student-final-1234',
      });
    expect(changed.status).toBe(201);
    return {
      accountId,
      auth: await loginAs(
        'enrollment-e2e-student',
        'enrollment-e2e-student-final-1234',
      ),
    };
  }

  async function createCourse(owner: AuthenticatedAgent): Promise<string> {
    const response = await owner.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, owner.csrfToken)
      .send({ name: 'Enrollment E2E Course' });
    expect(response.status).toBe(201);
    return response.body.data.id as string;
  }

  it('adds, lists, removes idempotently, and reactivates a student roster row', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await createTeacher(admin);
    const student = await createStudent(admin);
    const courseId = await createCourse(teacher.auth);

    const added = await teacher.auth.agent
      .post(`/api/v1/courses/${courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(added.status).toBe(201);
    expect(added.body.data.status).toBe('active');
    expect(added.body.data.student).toEqual({
      id: student.accountId,
      username: 'enrollment-e2e-student',
      displayName: 'Enrollment E2E Student',
    });
    expect(added.body.data).not.toHaveProperty('passwordHash');
    expect(added.body.data).not.toHaveProperty('cookieHash');

    const duplicate = await teacher.auth.agent
      .post(`/api/v1/courses/${courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(duplicate.status).toBe(201);
    expect(duplicate.body.data.id).toBe(added.body.data.id);
    expect(
      await prisma.prisma.courseEnrollment.count({
        where: { courseId, studentAccountId: student.accountId },
      }),
    ).toBe(1);

    const roster = await teacher.auth.agent.get(
      `/api/v1/courses/${courseId}/enrollments?page=1&pageSize=1`,
    );
    expect(roster.status).toBe(200);
    expect(roster.body.data.data).toHaveLength(1);
    expect(roster.body.data.meta).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 1,
      totalPages: 1,
    });

    const myCourses = await student.auth.agent.get('/api/v1/me/courses');
    expect(myCourses.status).toBe(200);
    expect(myCourses.body.data.data).toHaveLength(1);
    expect(myCourses.body.data.data[0]).toMatchObject({
      courseId,
      enrollmentId: added.body.data.id,
      name: 'Enrollment E2E Course',
    });

    const removed = await teacher.auth.agent
      .delete(`/api/v1/courses/${courseId}/enrollments/${student.accountId}`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(removed.status).toBe(200);
    expect(removed.body.data).toBeNull();

    const repeatedRemoval = await teacher.auth.agent
      .delete(`/api/v1/courses/${courseId}/enrollments/${student.accountId}`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(repeatedRemoval.status).toBe(200);

    const afterRemoval = await student.auth.agent.get('/api/v1/me/courses');
    expect(afterRemoval.status).toBe(200);
    expect(afterRemoval.body.data.data).toHaveLength(0);

    const reactivated = await teacher.auth.agent
      .post(`/api/v1/courses/${courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(reactivated.status).toBe(201);
    expect(reactivated.body.data.id).toBe(added.body.data.id);
    expect(reactivated.body.data.status).toBe('active');
  });

  it('hides cross-owner courses and rejects non-student or archived targets', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await createTeacher(admin);
    const otherTeacherAccountId = await createAccount(admin, {
      username: 'enrollment-e2e-other-teacher',
      displayName: 'Enrollment E2E Other Teacher',
      role: AccountRole.TEACHER,
      tempPassword: 'enrollment-e2e-other-teacher-temp-1234',
    });
    const otherTemporary = await loginAs(
      'enrollment-e2e-other-teacher',
      'enrollment-e2e-other-teacher-temp-1234',
    );
    await otherTemporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, otherTemporary.csrfToken)
      .send({
        currentPassword: 'enrollment-e2e-other-teacher-temp-1234',
        newPassword: 'enrollment-e2e-other-teacher-final-1234',
      });
    const otherTeacher = await loginAs(
      'enrollment-e2e-other-teacher',
      'enrollment-e2e-other-teacher-final-1234',
    );
    const student = await createStudent(admin);
    const ownCourseId = await createCourse(teacher.auth);
    const otherCourseId = await createCourse(otherTeacher);

    const hiddenList = await teacher.auth.agent.get(
      `/api/v1/courses/${otherCourseId}/enrollments`,
    );
    expect(hiddenList.status).toBe(404);

    const hiddenAdd = await teacher.auth.agent
      .post(`/api/v1/courses/${otherCourseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(hiddenAdd.status).toBe(404);

    const nonStudent = await teacher.auth.agent
      .post(`/api/v1/courses/${ownCourseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ studentAccountId: otherTeacherAccountId });
    expect(nonStudent.status).toBe(404);

    const archived = await teacher.auth.agent
      .post(`/api/v1/courses/${ownCourseId}/archive`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(archived.status).toBe(201);

    const archivedAdd = await teacher.auth.agent
      .post(`/api/v1/courses/${ownCourseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(archivedAdd.status).toBe(409);

    const studentRoster = await student.auth.agent.get(
      `/api/v1/courses/${ownCourseId}/enrollments`,
    );
    expect(studentRoster.status).toBe(403);
  });
});
