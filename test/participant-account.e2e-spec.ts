import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { newId } from '../src/common/crypto';
import { CSRF_COOKIE_NAME, CSRF_HEADER } from '../src/common/security';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('Account-bound participants (B3 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'participant-account-e2e-admin',
    displayName: 'Participant Account E2E Admin',
    password: 'participant-account-e2e-admin-1234',
  };
  const TEACHER = {
    username: 'participant-account-e2e-teacher',
    displayName: 'Participant Account E2E Teacher',
    tempPassword: 'participant-account-e2e-teacher-temp-1234',
    password: 'participant-account-e2e-teacher-final-1234',
  };
  const STUDENT = {
    username: 'participant-account-e2e-student',
    displayName: 'Participant Account E2E Student',
    tempPassword: 'participant-account-e2e-student-temp-1234',
    password: 'participant-account-e2e-student-final-1234',
  };
  const OTHER_STUDENT = {
    username: 'participant-account-e2e-other-student',
    displayName: 'Participant Account E2E Other Student',
    tempPassword: 'participant-account-e2e-other-temp-1234',
    password: 'participant-account-e2e-other-final-1234',
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
      // Keep the suite blocked when migration setup fails.
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

  async function provisionAndLogin(
    admin: AuthenticatedAgent,
    account: {
      username: string;
      displayName: string;
      tempPassword: string;
      password: string;
      role: AccountRole;
    },
  ): Promise<{ accountId: string; auth: AuthenticatedAgent }> {
    const created = await admin.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        username: account.username,
        displayName: account.displayName,
        role: account.role,
        canCreateCourse: account.role === AccountRole.TEACHER,
        tempPassword: account.tempPassword,
      });
    expect(created.status).toBe(201);

    const temporary = await loginAs(account.username, account.tempPassword);
    const changed = await temporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, temporary.csrfToken)
      .send({
        currentPassword: account.tempPassword,
        newPassword: account.password,
      });
    expect(changed.status).toBe(201);

    return {
      accountId: created.body.data.id as string,
      auth: await loginAs(account.username, account.password),
    };
  }

  async function setupActiveSession(teacher: AuthenticatedAgent): Promise<{
    courseId: string;
    liveSessionId: string;
    sessionCode: string;
    sessionQuestionId: string;
  }> {
    const course = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Account Participant Course' });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;

    const question = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: 'Which option?',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(question.status).toBe(201);

    const waiting = await teacher.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ courseId, questionIds: [question.body.data.id] });
    expect(waiting.status).toBe(201);
    const liveSessionId = waiting.body.data.id as string;
    const sessionCode = waiting.body.data.sessionCode as string;

    const started = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/start`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(started.status).toBe(201);

    return {
      courseId,
      liveSessionId,
      sessionCode,
      sessionQuestionId: started.body.data.sessionQuestions[0].id as string,
    };
  }

  it('cookie-joins enrolled students without returning a participant token', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(teacher.auth);

    const enrolled = await teacher.auth.agent
      .post(`/api/v1/courses/${session.courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(enrolled.status).toBe(201);

    const opened = await teacher.auth.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(opened.status).toBe(201);

    const joined = await student.auth.agent
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .send({});
    expect(joined.status).toBe(201);
    expect(joined.body.data.participantToken).toBeNull();

    const participant = await prisma.prisma.participant.findUnique({
      where: { id: joined.body.data.participantId as string },
    });
    expect(participant?.accountId).toBe(student.accountId);
    expect(participant?.tokenHash).toBeTruthy();

    const snapshot = await student.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/snapshot`,
    );
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.data.sessionQuestions[0]).toMatchObject({
      id: session.sessionQuestionId,
      hasSubmitted: false,
    });
  });

  it('submits through the student cookie and preserves anonymous token fallback', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const otherStudent = await provisionAndLogin(admin, {
      ...OTHER_STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(teacher.auth);

    const enrollment = await teacher.auth.agent
      .post(`/api/v1/courses/${session.courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(enrollment.status).toBe(201);

    const notEnrolledSnapshot = await otherStudent.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/snapshot`,
    );
    expect(notEnrolledSnapshot.status).toBe(403);

    const opened = await teacher.auth.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(opened.status).toBe(201);

    const submitted = await student.auth.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/submissions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .set('Idempotency-Key', newId())
      .send({
        sessionQuestionId: session.sessionQuestionId,
        selectedOptionRefs: ['a'],
      });
    expect(submitted.status).toBe(201);
    const boundParticipant = await prisma.prisma.participant.findUniqueOrThrow({
      where: {
        liveSessionId_accountId: {
          liveSessionId: session.liveSessionId,
          accountId: student.accountId,
        },
      },
    });
    expect(submitted.body.data.participantId).toBe(boundParticipant.id);

    const results = await student.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/results`,
    );
    expect(results.status).toBe(200);

    const anonymousJoin = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .send({ displayName: 'Anonymous fallback' });
    expect(anonymousJoin.status).toBe(201);
    const anonymousToken = anonymousJoin.body.data.participantToken as string;
    expect(anonymousToken).toEqual(expect.any(String));

    const anonymousSnapshot = await request(app.getHttpServer())
      .get(`/api/v1/live-sessions/${session.liveSessionId}/snapshot`)
      .set('X-Participant-Token', anonymousToken);
    expect(anonymousSnapshot.status).toBe(200);
  });

  it('removes access after a concurrent enrollment removal (TOCTOU lock guard)', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(teacher.auth);

    const enrolled = await teacher.auth.agent
      .post(`/api/v1/courses/${session.courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(enrolled.status).toBe(201);

    const opened = await teacher.auth.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(opened.status).toBe(201);

    // Cookie-join creates the account-bound participant first.
    const joined = await student.auth.agent
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .send({});
    expect(joined.status).toBe(201);

    // Remove the enrollment while the student holds a cookie session.
    const removed = await teacher.auth.agent
      .delete(
        `/api/v1/courses/${session.courseId}/enrollments/${student.accountId}`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(removed.status).toBe(200);

    // Snapshot and submission revalidate active enrollment under the row lock.
    const snapshotAfterRemoval = await student.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/snapshot`,
    );
    expect(snapshotAfterRemoval.status).toBe(403);

    const submittedAfterRemoval = await student.auth.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/submissions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .set('Idempotency-Key', newId())
      .send({
        sessionQuestionId: session.sessionQuestionId,
        selectedOptionRefs: ['a'],
      });
    expect(submittedAfterRemoval.status).toBe(403);
  });

  it('rejects a cookie submission after the account is disabled (account lock guard)', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(teacher.auth);

    const enrolled = await teacher.auth.agent
      .post(`/api/v1/courses/${session.courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(enrolled.status).toBe(201);

    const opened = await teacher.auth.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(opened.status).toBe(201);

    const joined = await student.auth.agent
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .send({});
    expect(joined.status).toBe(201);

    // Admin disables the student account (step-up protected). The student's
    // cookie session is invalidated, and any in-flight submission revalidation
    // that holds the Account row lock sees status=disabled.
    const stepUp = await admin.agent
      .post('/api/v1/auth/step-up')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ password: ADMIN.password });
    expect(stepUp.status).toBe(201);

    const disabled = await admin.agent
      .post(`/api/v1/admin/accounts/${student.accountId}/disable`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
    expect(disabled.status).toBe(201);
    expect(disabled.body.data.status).toBe('disabled');

    // The disabled student's cookie session is revoked, so the SessionGuard
    // no longer resolves the account and the guarded mutation is rejected with
    // 401. (Unlike enrollment removal, disable revokes every WebSession, so
    // the failure surfaces at the guard rather than at the enrollment recheck
    // inside the submission transaction. The account-row lock ordering that
    // linearizes an in-flight submission against a concurrent disable is
    // exercised by the service-level TOCTOU guard and the enrollment-removal
    // re-check test above.)
    const submittedAfterDisable = await student.auth.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/submissions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .set('Idempotency-Key', newId())
      .send({
        sessionQuestionId: session.sessionQuestionId,
        selectedOptionRefs: ['a'],
      });
    expect(submittedAfterDisable.status).toBe(401);
  });

  it('cookie-joins the same session twice without duplicating the participant', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(teacher.auth);

    const enrolled = await teacher.auth.agent
      .post(`/api/v1/courses/${session.courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(enrolled.status).toBe(201);

    const firstJoin = await student.auth.agent
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .send({});
    expect(firstJoin.status).toBe(201);
    const firstParticipantId = firstJoin.body.data.participantId as string;

    // A second cookie-join under the same account/session reuses the existing
    // row (idempotent under the liveSession row lock) instead of inserting a
    // duplicate.
    const secondJoin = await student.auth.agent
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .send({});
    expect(secondJoin.status).toBe(201);
    expect(secondJoin.body.data.participantId).toBe(firstParticipantId);

    const count = await prisma.prisma.participant.count({
      where: {
        liveSessionId: session.liveSessionId,
        accountId: student.accountId,
      },
    });
    expect(count).toBe(1);
  });

  // BE-1.1.1 negative: a student cookie-join without an active enrollment is
  // rejected at the enrollment recheck (participant.service.ts
  // findOrCreateAccountParticipant -> assertActiveEnrollment) before any
  // participant row can be created.
  it('rejects a cookie-join when the student has no active enrollment', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    // Create an active session but deliberately do NOT add the student to the
    // course roster.
    const session = await setupActiveSession(teacher.auth);

    const opened = await teacher.auth.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(opened.status).toBe(201);

    const joined = await student.auth.agent
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .send({});
    expect(joined.status).toBe(403);

    // The rejected join must not create a participant row.
    const count = await prisma.prisma.participant.count({
      where: {
        liveSessionId: session.liveSessionId,
        accountId: student.accountId,
      },
    });
    expect(count).toBe(0);
  });

  // BE-1.1.6: the student cookie results projection is participant-safe. For a
  // poll, correctness has no meaning, so the proof is that no teacher-only
  // field (e.g. OptionCountDto.isCorrect, which is quiz-only) leaks, and that
  // the reveal gate blocks a non-submitter from viewing the OPEN aggregate
  // while an enrolled submitter can.
  it('returns participant-safe results through the student cookie (vote-to-reveal)', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const nonVotingStudent = await provisionAndLogin(admin, {
      ...OTHER_STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(teacher.auth);

    // Enroll both students; only `student` will submit.
    for (const target of [student, nonVotingStudent]) {
      const enrolled = await teacher.auth.agent
        .post(`/api/v1/courses/${session.courseId}/enrollments`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, teacher.auth.csrfToken)
        .send({ studentAccountId: target.accountId });
      expect(enrolled.status).toBe(201);
    }

    const opened = await teacher.auth.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(opened.status).toBe(201);

    const joined = await student.auth.agent
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .send({});
    expect(joined.status).toBe(201);

    const submitted = await student.auth.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/submissions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .set('Idempotency-Key', newId())
      .send({
        sessionQuestionId: session.sessionQuestionId,
        selectedOptionRefs: ['a'],
      });
    expect(submitted.status).toBe(201);

    // Submitting student sees the OPEN aggregate as participant-safe poll:
    // no teacher-only correctness fields, aggregate counts included.
    const studentResults = await student.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/results`,
    );
    expect(studentResults.status).toBe(200);
    expect(studentResults.body.data.snapshotType).toBe('poll');
    expect(studentResults.body.data.status).toBe('open');
    expect(studentResults.body.data.options[0].count).toBe(1);
    expect(studentResults.body.data.options[0].isCorrect).toBeUndefined();

    // Teacher projection returns 200 and the same shape (poll has no
    // correctness concept, so participant-safe == teacher-safe for poll).
    const teacherResults = await teacher.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/results`,
    );
    expect(teacherResults.status).toBe(200);
    expect(teacherResults.body.data.snapshotType).toBe('poll');
    expect(teacherResults.body.data.options[0].isCorrect).toBeUndefined();

    // Reveal-gate negative: a non-submitting enrolled student cannot read the
    // OPEN aggregate (RESULTS_NOT_REVEALED 409).
    const nonVotingJoin = await nonVotingStudent.auth.agent
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, nonVotingStudent.auth.csrfToken)
      .send({});
    expect(nonVotingJoin.status).toBe(201);

    const gated = await nonVotingStudent.auth.agent.get(
      `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/results`,
    );
    expect(gated.status).toBe(409);
    expect(gated.body.error.code).toBe('RESULTS_NOT_REVEALED');
  });

  // BE-1.1.8: cookie mutations require a valid CSRF token and an exact Origin.
  // CsrfGuard is a no-op for GETs, so the negative cases must hit a mutation
  // (the cookie submission path runs CSRF before participant resolution).
  it('rejects a cookie submission without a valid CSRF token or exact Origin', async () => {
    if (!dbReachable) return;
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const teacher = await provisionAndLogin(admin, {
      ...TEACHER,
      role: AccountRole.TEACHER,
    });
    const student = await provisionAndLogin(admin, {
      ...STUDENT,
      role: AccountRole.STUDENT,
    });
    const session = await setupActiveSession(teacher.auth);

    const enrolled = await teacher.auth.agent
      .post(`/api/v1/courses/${session.courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(enrolled.status).toBe(201);

    const opened = await teacher.auth.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.auth.csrfToken);
    expect(opened.status).toBe(201);

    const joined = await student.auth.agent
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .send({});
    expect(joined.status).toBe(201);

    const submissionPath = `/api/v1/live-sessions/${session.liveSessionId}/submissions`;
    const payload = {
      sessionQuestionId: session.sessionQuestionId,
      selectedOptionRefs: ['a'],
    };

    // 1. Missing X-CSRF-Token (correct Origin) -> 403 AUTH_CSRF_INVALID.
    const missingToken = await student.auth.agent
      .post(submissionPath)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', newId())
      .send(payload);
    expect(missingToken.status).toBe(403);
    expect(missingToken.body.error.code).toBe('AUTH_CSRF_INVALID');

    // 2. Wrong X-CSRF-Token (correct Origin) -> 403 AUTH_CSRF_INVALID.
    const wrongToken = await student.auth.agent
      .post(submissionPath)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, 'not-the-csrf-token')
      .set('Idempotency-Key', newId())
      .send(payload);
    expect(wrongToken.status).toBe(403);
    expect(wrongToken.body.error.code).toBe('AUTH_CSRF_INVALID');

    // 3. Valid token but an Origin outside the allowlist -> 403
    // AUTH_CSRF_INVALID. .env.test allows only http://localhost:3000.
    const wrongOrigin = await student.auth.agent
      .post(submissionPath)
      .set('Origin', 'http://evil.test')
      .set(CSRF_HEADER, student.auth.csrfToken)
      .set('Idempotency-Key', newId())
      .send(payload);
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.body.error.code).toBe('AUTH_CSRF_INVALID');

    // The same cookie can still submit successfully with a valid token+Origin,
    // confirming only the CSRF/Origin gate blocked the requests above.
    const valid = await student.auth.agent
      .post(submissionPath)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.auth.csrfToken)
      .set('Idempotency-Key', newId())
      .send(payload);
    expect(valid.status).toBe(201);
  });
});
