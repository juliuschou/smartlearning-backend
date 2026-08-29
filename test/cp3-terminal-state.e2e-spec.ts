import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { newId } from '../src/common/crypto';
import { CSRF_HEADER } from '../src/common/security';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { LiveSessionPublisher } from '../src/modules/realtime/live-session-publisher';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('CP3 terminal-state negative paths (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;
  const origin = 'http://localhost:3000';
  const admin = {
    username: 'cp3-admin',
    displayName: 'CP3 Admin',
    password: 'cp3-admin-password-1234',
  };
  const teacher = {
    username: 'cp3-teacher',
    displayName: 'CP3 Teacher',
    tempPassword: 'cp3-teacher-temp-1234',
    password: 'cp3-teacher-final-1234',
  };
  const student = {
    username: 'cp3-student',
    displayName: 'CP3 Student',
    tempPassword: 'cp3-student-temp-1234',
    password: 'cp3-student-final-1234',
  };

  type Auth = { agent: request.SuperAgentTest; csrfToken: string };
  type Session = {
    courseId: string;
    liveSessionId: string;
    sessionCode: string;
    questionId: string;
    sessionQuestionId: string;
  };

  beforeAll(async () => {
    try {
      setupTestDb();
      migrationsReady = true;
    } catch {
      /* suite remains blocked */
    }
    app = await createTestApp();
    await app.init();
    // CP3 only checks HTTP terminal boundaries; stop the durable publisher so
    // its projection reads cannot race the per-case database truncation.
    await app.get(LiveSessionPublisher).onModuleDestroy();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);
    if (migrationsReady) {
      try {
        await prisma.prisma
          .$queryRaw`SELECT 1 FROM question_definition LIMIT 0`;
        dbReachable = true;
      } catch {
        dbReachable = false;
      }
    }
  });
  afterAll(async () => {
    if (app) await app.close();
  });
  beforeEach(async () => {
    if (dbReachable) {
      await truncateAll(prisma.prisma);
      await bootstrap.createFirstAdmin(admin);
    }
  });

  function cookies(value: string | string[] | undefined): string[] {
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  }
  function cookie(setCookie: string[] | undefined, name: string): string {
    const prefix = `${name}=`;
    const found = setCookie?.find((item) => item.startsWith(prefix));
    if (!found) throw new Error(`Missing ${name} cookie`);
    return found.split(';', 1)[0].slice(prefix.length);
  }
  async function login(username: string, password: string): Promise<Auth> {
    const agent = request.agent(app.getHttpServer());
    const response = await agent
      .post('/api/v1/auth/login')
      .send({ username, password });
    expect(response.status).toBe(201);
    return {
      agent: agent as unknown as request.SuperAgentTest,
      csrfToken: cookie(cookies(response.headers['set-cookie']), '__Host-csrf'),
    };
  }
  async function provision(
    account: typeof teacher | typeof student,
    role: AccountRole,
  ): Promise<{ id: string; auth: Auth }> {
    const adminAuth = await login(admin.username, admin.password);
    const created = await adminAuth.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', origin)
      .set(CSRF_HEADER, adminAuth.csrfToken)
      .send({
        username: account.username,
        displayName: account.displayName,
        role,
        canCreateCourse: role === AccountRole.TEACHER,
        tempPassword: account.tempPassword,
      });
    expect(created.status).toBe(201);
    const temporary = await login(account.username, account.tempPassword);
    const changed = await temporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', origin)
      .set(CSRF_HEADER, temporary.csrfToken)
      .send({
        currentPassword: account.tempPassword,
        newPassword: account.password,
      });
    expect(changed.status).toBe(201);
    return {
      id: created.body.data.id as string,
      auth: await login(account.username, account.password),
    };
  }
  async function setupSession(
    teacherAuth: Auth,
    start = true,
  ): Promise<Session> {
    const course = await teacherAuth.agent
      .post('/api/v1/courses')
      .set('Origin', origin)
      .set(CSRF_HEADER, teacherAuth.csrfToken)
      .send({ name: 'CP3 Course' });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;
    const question = await teacherAuth.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', origin)
      .set(CSRF_HEADER, teacherAuth.csrfToken)
      .send({
        type: 'poll',
        prompt: 'CP3 question',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      });
    expect(question.status).toBe(201);
    const questionId = question.body.data.id as string;
    const waiting = await teacherAuth.agent
      .post('/api/v1/live-sessions')
      .set('Origin', origin)
      .set(CSRF_HEADER, teacherAuth.csrfToken)
      .send({ courseId, questionIds: [questionId] });
    expect(waiting.status).toBe(201);
    if (!start) {
      return {
        courseId,
        questionId,
        liveSessionId: waiting.body.data.id as string,
        sessionCode: waiting.body.data.sessionCode as string,
        sessionQuestionId: '',
      };
    }
    const started = await teacherAuth.agent
      .post(`/api/v1/live-sessions/${waiting.body.data.id}/start`)
      .set('Origin', origin)
      .set(CSRF_HEADER, teacherAuth.csrfToken);
    expect(started.status).toBe(201);
    return {
      courseId,
      questionId,
      liveSessionId: waiting.body.data.id as string,
      sessionCode: waiting.body.data.sessionCode as string,
      sessionQuestionId: started.body.data.sessionQuestions[0].id as string,
    };
  }
  async function joinAnonymous(
    session: Session,
  ): Promise<{ id: string; token: string }> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .send({ displayName: 'anonymous' });
    expect(response.status).toBe(201);
    return {
      id: response.body.data.participantId as string,
      token: response.body.data.participantToken as string,
    };
  }
  function submitPath(session: Session): string {
    return `/api/v1/live-sessions/${session.liveSessionId}/submissions`;
  }
  function expectTerminal(response: request.Response): void {
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SESSION_NOT_JOINABLE');
  }
  function requireDb(): void {
    if (!dbReachable)
      throw new Error(
        'BLOCKED: smartlearning_test is unavailable for CP3 e2e tests.',
      );
  }

  it.each(['closed', 'cancelled'])(
    'rejects direct anonymous and account-bound joins and reconnects after %s',
    async (state) => {
      requireDb();
      const teacherAuth = await provision(teacher, AccountRole.TEACHER);
      const studentAccount = await provision(
        { ...student, username: `${student.username}-${state}` },
        AccountRole.STUDENT,
      );
      const session = await setupSession(
        teacherAuth.auth,
        state !== 'cancelled',
      );
      const enrolled = await teacherAuth.auth.agent
        .post(`/api/v1/courses/${session.courseId}/enrollments`)
        .set('Origin', origin)
        .set(CSRF_HEADER, teacherAuth.auth.csrfToken)
        .send({ studentAccountId: studentAccount.id });
      expect(enrolled.status).toBe(201);
      const anonymous = await joinAnonymous(session);
      const action = state === 'closed' ? 'close' : 'cancel';
      const terminal = await teacherAuth.auth.agent
        .post(`/api/v1/live-sessions/${session.liveSessionId}/${action}`)
        .set('Origin', origin)
        .set(CSRF_HEADER, teacherAuth.auth.csrfToken);
      expect(terminal.status).toBe(201);
      const before = await prisma.prisma.participant.count({
        where: { liveSessionId: session.liveSessionId },
      });
      expect(before).toBe(1);
      expectTerminal(
        await request(app.getHttpServer())
          .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
          .send({ displayName: 'new' }),
      );
      expectTerminal(
        await studentAccount.auth.agent
          .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
          .set('Origin', origin)
          .set(CSRF_HEADER, studentAccount.auth.csrfToken)
          .send({}),
      );
      expectTerminal(
        await request(app.getHttpServer())
          .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
          .set('X-Participant-Token', anonymous.token)
          .send({ displayName: 'reconnect' }),
      );
      expect(
        await prisma.prisma.participant.count({
          where: { liveSessionId: session.liveSessionId },
        }),
      ).toBe(before);
    },
  );

  it('rejects anonymous and account-bound submissions after session close with no row side effects', async () => {
    requireDb();
    const teacherAuth = await provision(teacher, AccountRole.TEACHER);
    const studentAuth = await provision(
      { ...student, username: 'cp3-student-close' },
      AccountRole.STUDENT,
    );
    const session = await setupSession(teacherAuth.auth);
    expect(
      (
        await teacherAuth.auth.agent
          .post(`/api/v1/courses/${session.courseId}/enrollments`)
          .set('Origin', origin)
          .set(CSRF_HEADER, teacherAuth.auth.csrfToken)
          .send({ studentAccountId: studentAuth.id })
      ).status,
    ).toBe(201);
    const open = await teacherAuth.auth.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', origin)
      .set(CSRF_HEADER, teacherAuth.auth.csrfToken);
    expect(open.status).toBe(201);
    const anonymous = await joinAnonymous(session);
    const accountJoin = await studentAuth.auth.agent
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .set('Origin', origin)
      .set(CSRF_HEADER, studentAuth.auth.csrfToken)
      .send({});
    expect(accountJoin.status).toBe(201);
    const close = await teacherAuth.auth.agent
      .post(`/api/v1/live-sessions/${session.liveSessionId}/close`)
      .set('Origin', origin)
      .set(CSRF_HEADER, teacherAuth.auth.csrfToken);
    expect(close.status).toBe(201);
    const before = await prisma.prisma.submission.count({
      where: { liveSessionId: session.liveSessionId },
    });
    const anonymousResponse = await request(app.getHttpServer())
      .post(submitPath(session))
      .set('X-Participant-Token', anonymous.token)
      .set('Idempotency-Key', newId())
      .send({
        sessionQuestionId: session.sessionQuestionId,
        selectedOptionRefs: ['a'],
      });
    expect(anonymousResponse.status).toBe(401);
    expect(anonymousResponse.body.error.code).toBe('UNAUTHORIZED');

    const accountResponse = await studentAuth.auth.agent
      .post(submitPath(session))
      .set('Origin', origin)
      .set(CSRF_HEADER, studentAuth.auth.csrfToken)
      .set('Idempotency-Key', newId())
      .send({
        sessionQuestionId: session.sessionQuestionId,
        selectedOptionRefs: ['a'],
      });
    expectTerminal(accountResponse);
    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(before);
    expect(
      await prisma.prisma.liveSession.findUniqueOrThrow({
        where: { id: session.liveSessionId },
        select: { status: true },
      }),
    ).toMatchObject({ status: 'closed' });
  });

  it('rejects anonymous and account-bound submissions after question close without submissions or state mutation', async () => {
    requireDb();
    const teacherAuth = await provision(teacher, AccountRole.TEACHER);
    const studentAuth = await provision(
      { ...student, username: 'cp3-student-question-close' },
      AccountRole.STUDENT,
    );
    const session = await setupSession(teacherAuth.auth);
    expect(
      (
        await teacherAuth.auth.agent
          .post(`/api/v1/courses/${session.courseId}/enrollments`)
          .set('Origin', origin)
          .set(CSRF_HEADER, teacherAuth.auth.csrfToken)
          .send({ studentAccountId: studentAuth.id })
      ).status,
    ).toBe(201);
    const open = await teacherAuth.auth.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/open`,
      )
      .set('Origin', origin)
      .set(CSRF_HEADER, teacherAuth.auth.csrfToken);
    expect(open.status).toBe(201);
    const anonymous = await joinAnonymous(session);
    const accountJoin = await studentAuth.auth.agent
      .post(`/api/v1/live-sessions/${session.sessionCode}/join`)
      .set('Origin', origin)
      .set(CSRF_HEADER, studentAuth.auth.csrfToken)
      .send({});
    expect(accountJoin.status).toBe(201);
    const before = await prisma.prisma.sessionQuestion.findUniqueOrThrow({
      where: { id: session.sessionQuestionId },
      select: { status: true, closedAt: true },
    });
    const close = await teacherAuth.auth.agent
      .post(
        `/api/v1/live-sessions/${session.liveSessionId}/questions/${session.sessionQuestionId}/close`,
      )
      .set('Origin', origin)
      .set(CSRF_HEADER, teacherAuth.auth.csrfToken);
    expect(close.status).toBe(201);
    const afterClose = await prisma.prisma.sessionQuestion.findUniqueOrThrow({
      where: { id: session.sessionQuestionId },
      select: { status: true, closedAt: true },
    });
    expect(afterClose.status).toBe('closed');
    expect(afterClose.closedAt).not.toBeNull();
    for (const response of [
      await request(app.getHttpServer())
        .post(submitPath(session))
        .set('X-Participant-Token', anonymous.token)
        .set('Idempotency-Key', newId())
        .send({
          sessionQuestionId: session.sessionQuestionId,
          selectedOptionRefs: ['a'],
        }),
      await studentAuth.auth.agent
        .post(submitPath(session))
        .set('Origin', origin)
        .set(CSRF_HEADER, studentAuth.auth.csrfToken)
        .set('Idempotency-Key', newId())
        .send({
          sessionQuestionId: session.sessionQuestionId,
          selectedOptionRefs: ['a'],
        }),
    ]) {
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    }
    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.sessionQuestion.findUniqueOrThrow({
        where: { id: session.sessionQuestionId },
        select: { status: true, closedAt: true },
      }),
    ).toEqual(afterClose);
    expect(before.status).toBe('open');
    expect(
      await prisma.prisma.participant.count({
        where: { liveSessionId: session.liveSessionId },
      }),
    ).toBe(2);
  });
});
