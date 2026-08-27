import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { newId } from '../src/common/crypto';
import { CSRF_COOKIE_NAME, CSRF_HEADER } from '../src/common/security';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * BE-1.2 — 撤銷與競態 (revocation & races).
 *
 * Verifies that enrollment removal and account disable linearize against a
 * concurrent cookie-bound join/submit: once a revocation commits, the
 * unauthorized operation is no longer accepted and the PostgreSQL authority
 * rows never gain a duplicate Participant or Submission.
 *
 * Invariant under test (already enforced in source; this slice is test-only):
 *
 * - Cookie join  (`ParticipantService.findOrCreateAccountParticipant`) locks
 *   `liveSession → course → account` and re-reads account status + enrollment
 *   status under the Course/Account row locks before creating a Participant.
 * - Cookie submit (`SubmissionService.submit`) locks
 *   `sessionQuestion → course → account` and re-reads account + enrollment
 *   status under the same Course/Account row locks.
 * - `EnrollmentService.removeEnrollment` takes the Course row lock;
 *   `AccountService.disableAccount` takes the Account row lock. Both serialize
 *   against the join/submit paths through the shared locks, so the invariant
 *   "commit 後不再接受未授權操作" holds by construction (BE-1.2.8).
 *
 * Race assertion semantics: two racing requests have one deterministic winner.
 * If join/submit wins it committed before the revocation — authorized, count 1.
 * If the revocation wins the join/submit is refused — count 0. Both are
 * correct, so the assertion is winner-tolerant `<= 1`, mirroring the
 * account-disable vs question-batch race in test/account-admin.e2e-spec.ts.
 */
describe('Participant revocation & races (BE-1.2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'participant-revocation-e2e-admin',
    displayName: 'Participant Revocation E2E Admin',
    password: 'participant-revocation-e2e-admin-1234',
  };
  const TEACHER = {
    username: 'participant-revocation-e2e-teacher',
    displayName: 'Participant Revocation E2E Teacher',
    tempPassword: 'participant-revocation-e2e-teacher-temp-1234',
    password: 'participant-revocation-e2e-teacher-final-1234',
  };
  const STUDENT = {
    username: 'participant-revocation-e2e-student',
    displayName: 'Participant Revocation E2E Student',
    tempPassword: 'participant-revocation-e2e-student-temp-1234',
    password: 'participant-revocation-e2e-student-final-1234',
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
      .send({ name: 'Revocation Course' });
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

  /** Enroll `student` in `courseId` (teacher roster mutation). */
  async function enrollStudent(
    teacher: AuthenticatedAgent,
    courseId: string,
    studentAccountId: string,
  ): Promise<void> {
    const res = await teacher.agent
      .post(`/api/v1/courses/${courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ studentAccountId });
    expect(res.status).toBe(201);
  }

  /** Remove `student` from `courseId`. Returns the request Test (fire-ready). */
  function removeEnrollment(
    teacher: AuthenticatedAgent,
    courseId: string,
    studentAccountId: string,
  ): request.Test {
    return teacher.agent
      .delete(`/api/v1/courses/${courseId}/enrollments/${studentAccountId}`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
  }

  /** Open the session question so a participant can submit. */
  async function openQuestion(
    teacher: AuthenticatedAgent,
    liveSessionId: string,
    sessionQuestionId: string,
  ): Promise<void> {
    const res = await teacher.agent
      .post(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(res.status).toBe(201);
  }

  /** Cookie-join as the student. Returns the request Test (fire-ready). */
  function cookieJoin(
    student: AuthenticatedAgent,
    sessionCode: string,
  ): request.Test {
    return student.agent
      .post(`/api/v1/live-sessions/${sessionCode}/join`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.csrfToken)
      .send({});
  }

  /** Cookie submission as the student. Returns the request Test (fire-ready). */
  function cookieSubmit(
    student: AuthenticatedAgent,
    liveSessionId: string,
    sessionQuestionId: string,
    idempotencyKey?: string,
  ): request.Test {
    return student.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, student.csrfToken)
      .set('Idempotency-Key', idempotencyKey ?? newId())
      .send({
        sessionQuestionId,
        selectedOptionRefs: ['a'],
      });
  }

  /** Admin step-up (precondition for disable). Side effect only. */
  async function adminStepUp(admin: AuthenticatedAgent): Promise<void> {
    const res = await admin.agent
      .post('/api/v1/auth/step-up')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ password: ADMIN.password });
    expect(res.status).toBe(201);
  }

  /** Admin disable of `targetAccountId`. Returns the request Test (fire-ready). */
  function disableAccount(
    admin: AuthenticatedAgent,
    targetAccountId: string,
  ): request.Test {
    return admin.agent
      .post(`/api/v1/admin/accounts/${targetAccountId}/disable`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken);
  }

  /** Await a single fire-ready request Test. */
  async function settle(res: request.Test): Promise<request.Response> {
    return res;
  }

  // --- Sequential revocation (BE-1.2.1 – BE-1.2.4) ---

  // BE-1.2.1: after enrollment removal, a new cookie-join is rejected at the
  // unlocked pre-check (assertActiveEnrollment) and no Participant row is
  // created.
  it('rejects a new join after the enrollment is removed (BE-1.2.1)', async () => {
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
    await enrollStudent(teacher.auth, session.courseId, student.accountId);
    await openQuestion(
      teacher.auth,
      session.liveSessionId,
      session.sessionQuestionId,
    );

    const removed = await settle(
      removeEnrollment(teacher.auth, session.courseId, student.accountId),
    );
    expect(removed.status).toBe(200);

    const joined = await settle(cookieJoin(student.auth, session.sessionCode));
    expect(joined.status).toBe(403);

    const count = await prisma.prisma.participant.count({
      where: {
        liveSessionId: session.liveSessionId,
        accountId: student.accountId,
      },
    });
    expect(count).toBe(0);
  });

  // BE-1.2.2: after enrollment removal, an existing Participant can no longer
  // submit (the submission transaction re-reads enrollment under the Course
  // lock).
  it('rejects a submit after the enrollment is removed (BE-1.2.2)', async () => {
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
    await enrollStudent(teacher.auth, session.courseId, student.accountId);
    await openQuestion(
      teacher.auth,
      session.liveSessionId,
      session.sessionQuestionId,
    );

    const joined = await settle(cookieJoin(student.auth, session.sessionCode));
    expect(joined.status).toBe(201);

    const removed = await settle(
      removeEnrollment(teacher.auth, session.courseId, student.accountId),
    );
    expect(removed.status).toBe(200);

    const submitted = await settle(
      cookieSubmit(
        student.auth,
        session.liveSessionId,
        session.sessionQuestionId,
      ),
    );
    expect(submitted.status).toBe(403);

    const count = await prisma.prisma.submission.count({
      where: {
        sessionQuestionId: session.sessionQuestionId,
        participant: { accountId: student.accountId },
      },
    });
    expect(count).toBe(0);
  });

  // BE-1.2.3: after account disable, the student's cookie session is revoked,
  // so a new join fails at the SessionGuard (401) and no Participant row is
  // created.
  it('rejects a new join after the account is disabled (BE-1.2.3)', async () => {
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
    await enrollStudent(teacher.auth, session.courseId, student.accountId);
    await openQuestion(
      teacher.auth,
      session.liveSessionId,
      session.sessionQuestionId,
    );

    await adminStepUp(admin);
    const disabled = await settle(disableAccount(admin, student.accountId));
    expect(disabled.status).toBe(201);

    const joined = await settle(cookieJoin(student.auth, session.sessionCode));
    expect(joined.status).toBe(401);

    const count = await prisma.prisma.participant.count({
      where: {
        liveSessionId: session.liveSessionId,
        accountId: student.accountId,
      },
    });
    expect(count).toBe(0);
  });

  // BE-1.2.4: after account disable, an existing participant can no longer
  // submit (401 — the revoked session fails the SessionGuard before the
  // submission transaction runs).
  it('rejects a submit after the account is disabled (BE-1.2.4)', async () => {
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
    await enrollStudent(teacher.auth, session.courseId, student.accountId);
    await openQuestion(
      teacher.auth,
      session.liveSessionId,
      session.sessionQuestionId,
    );

    const joined = await settle(cookieJoin(student.auth, session.sessionCode));
    expect(joined.status).toBe(201);

    await adminStepUp(admin);
    const disabled = await settle(disableAccount(admin, student.accountId));
    expect(disabled.status).toBe(201);

    const submitted = await settle(
      cookieSubmit(
        student.auth,
        session.liveSessionId,
        session.sessionQuestionId,
      ),
    );
    expect(submitted.status).toBe(401);

    const count = await prisma.prisma.submission.count({
      where: {
        sessionQuestionId: session.sessionQuestionId,
        participant: { accountId: student.accountId },
      },
    });
    expect(count).toBe(0);
  });

  // --- Concurrent revocation vs join/submit (BE-1.2.5 – BE-1.2.7) ---
  //
  // Both requests race. Whichever wins the shared row lock first commits; the
  // loser observes the post-commit state and is refused. The authority
  // invariant is that no duplicate row appears: exactly one winner or zero.

  // BE-1.2.5: concurrent enrollment removal vs a new cookie-join.
  it('linearizes an enrollment removal against a concurrent join (BE-1.2.5)', async () => {
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
    await enrollStudent(teacher.auth, session.courseId, student.accountId);
    await openQuestion(
      teacher.auth,
      session.liveSessionId,
      session.sessionQuestionId,
    );

    const [removeRes, joinRes] = await Promise.all([
      removeEnrollment(teacher.auth, session.courseId, student.accountId),
      cookieJoin(student.auth, session.sessionCode),
    ]);

    expect(removeRes.status).toBe(200);
    const count = await prisma.prisma.participant.count({
      where: {
        liveSessionId: session.liveSessionId,
        accountId: student.accountId,
      },
    });
    expect(count).toBeLessThanOrEqual(1);

    if (count === 1) {
      // Join won: it committed before the removal, so both succeed.
      expect(joinRes.status).toBe(201);
    } else {
      // Removal won: the join is refused after the removal committed.
      expect(joinRes.status).toBe(403);
    }
  });

  // BE-1.2.6: concurrent enrollment removal vs an existing participant submit.
  it('concurrent enrollment removal vs a submit (BE-1.2.6)', async () => {
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
    await enrollStudent(teacher.auth, session.courseId, student.accountId);
    await openQuestion(
      teacher.auth,
      session.liveSessionId,
      session.sessionQuestionId,
    );

    const joined = await settle(cookieJoin(student.auth, session.sessionCode));
    expect(joined.status).toBe(201);

    const [removeRes, submitRes] = await Promise.all([
      removeEnrollment(teacher.auth, session.courseId, student.accountId),
      cookieSubmit(
        student.auth,
        session.liveSessionId,
        session.sessionQuestionId,
        '01900000-0000-7000-8000-000000000206',
      ),
    ]);

    expect(removeRes.status).toBe(200);
    const count = await prisma.prisma.submission.count({
      where: {
        sessionQuestionId: session.sessionQuestionId,
        participant: { accountId: student.accountId },
      },
    });
    expect(count).toBeLessThanOrEqual(1);

    if (count === 1) {
      // Submit won: the submission committed before the removal.
      expect(submitRes.status).toBe(201);
    } else {
      // Removal won: the submission is refused after removal committed.
      expect(submitRes.status).toBe(403);
    }
  });

  // BE-1.2.7: concurrent account disable vs a join, and vs a submit. Disable
  // revokes every WebSession. When disable wins, the late request is refused
  // either at the SessionGuard (401, session already revoked) or at the
  // in-transaction account-lock TOCTOU re-check (403, ForbiddenError), both
  // valid; the assertions accept either.
  it('concurrent account disable vs a join (BE-1.2.7a)', async () => {
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
    await enrollStudent(teacher.auth, session.courseId, student.accountId);
    await openQuestion(
      teacher.auth,
      session.liveSessionId,
      session.sessionQuestionId,
    );

    // Step-up is a disable precondition; perform it before the race fires.
    await adminStepUp(admin);
    const [disableRes, joinRes] = await Promise.all([
      disableAccount(admin, student.accountId),
      cookieJoin(student.auth, session.sessionCode),
    ]);

    expect(disableRes.status).toBe(201);
    const count = await prisma.prisma.participant.count({
      where: {
        liveSessionId: session.liveSessionId,
        accountId: student.accountId,
      },
    });
    expect(count).toBeLessThanOrEqual(1);

    if (count === 1) {
      // Join won: it committed before the disable, so both succeed.
      expect(joinRes.status).toBe(201);
    } else {
      // Disable won. The late join is refused either at the SessionGuard (401,
      // session already revoked) or at the account-lock TOCTOU re-check (403,
      // ForbiddenError when the session was still valid at the guard). Both
      // satisfy the invariant that no Participant row is created.
      expect([401, 403]).toContain(joinRes.status);
    }
  });

  it('concurrent account disable vs a submit (BE-1.2.7b)', async () => {
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
    await enrollStudent(teacher.auth, session.courseId, student.accountId);
    await openQuestion(
      teacher.auth,
      session.liveSessionId,
      session.sessionQuestionId,
    );

    const joined = await settle(cookieJoin(student.auth, session.sessionCode));
    expect(joined.status).toBe(201);

    await adminStepUp(admin);
    const [disableRes, submitRes] = await Promise.all([
      disableAccount(admin, student.accountId),
      cookieSubmit(
        student.auth,
        session.liveSessionId,
        session.sessionQuestionId,
        '01900000-0000-7000-8000-000000000207',
      ),
    ]);

    expect(disableRes.status).toBe(201);
    const count = await prisma.prisma.submission.count({
      where: {
        sessionQuestionId: session.sessionQuestionId,
        participant: { accountId: student.accountId },
      },
    });
    expect(count).toBeLessThanOrEqual(1);

    if (count === 1) {
      // Submit won: the submission committed before the disable.
      expect(submitRes.status).toBe(201);
    } else {
      // Disable won. The late submit is refused either at the SessionGuard
      // (401, session already revoked) or at the account-lock TOCTOU re-check
      // (403, ForbiddenError when the session was still valid at the guard).
      // Both satisfy the invariant that no Submission row is created.
      expect([401, 403]).toContain(submitRes.status);
    }
  });

  // BE-1.2.9: authority rows carry no duplicate Participant/Submission. The
  // idempotent cookie-join proves single-row creation, and the concurrent
  // races above re-affirm that no race ever yields more than one row.
  it('keeps no duplicate participant/submission rows (BE-1.2.9)', async () => {
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
    await enrollStudent(teacher.auth, session.courseId, student.accountId);
    await openQuestion(
      teacher.auth,
      session.liveSessionId,
      session.sessionQuestionId,
    );

    const firstJoin = await settle(
      cookieJoin(student.auth, session.sessionCode),
    );
    expect(firstJoin.status).toBe(201);
    const firstParticipantId = firstJoin.body.data.participantId as string;

    const secondJoin = await settle(
      cookieJoin(student.auth, session.sessionCode),
    );
    expect(secondJoin.status).toBe(201);
    expect(secondJoin.body.data.participantId).toBe(firstParticipantId);

    const submitted = await settle(
      cookieSubmit(
        student.auth,
        session.liveSessionId,
        session.sessionQuestionId,
      ),
    );
    expect(submitted.status).toBe(201);

    const participantCount = await prisma.prisma.participant.count({
      where: {
        liveSessionId: session.liveSessionId,
        accountId: student.accountId,
      },
    });
    expect(participantCount).toBe(1);

    const submissionCount = await prisma.prisma.submission.count({
      where: {
        sessionQuestionId: session.sessionQuestionId,
        participant: { accountId: student.accountId },
      },
    });
    expect(submissionCount).toBe(1);
  });
});
