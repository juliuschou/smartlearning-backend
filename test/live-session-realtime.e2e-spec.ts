import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import { SESSION_COOKIE_NAME } from '../src/common/security';
import { LiveSessionEventBus } from '../src/modules/realtime/live-session-event-bus';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * R-1 lite realtime e2e. Connects real socket.io-client clients to a real TCP
 * port and exercises the lifecycle event flow against PostgreSQL.
 */
describe('LiveSession realtime (R-1 lite) (e2e)', () => {
  let app: INestApplication;
  let httpServer: ReturnType<INestApplication['getHttpServer']>;
  let baseUrl: string;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'rt-e2e-admin',
    displayName: 'RT E2E Admin',
    password: 'rt-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'rt-e2e-teacher',
    displayName: 'RT E2E Teacher',
    tempPassword: 'rt-e2e-temp-password-1234',
    password: 'rt-e2e-final-password-1234',
  };
  const STUDENT = {
    username: 'rt-e2e-student',
    displayName: 'RT E2E Student',
    tempPassword: 'rt-e2e-student-temp-password-1234',
    password: 'rt-e2e-student-final-password-1234',
  };
  const OTHER_TEACHER = {
    username: 'rt-e2e-other-teacher',
    displayName: 'RT E2E Other Teacher',
    tempPassword: 'rt-e2e-other-temp-1234',
    password: 'rt-e2e-other-final-1234',
  };

  type AuthenticatedAgent = {
    agent: request.SuperAgentTest;
    csrfToken: string;
    sessionCookie: string;
  };

  // Collect socket events into a per-socket map of event -> payloads.
  function collectEvents(socket: ClientSocket): {
    events: Map<string, unknown[]>;
  } {
    const events = new Map<string, unknown[]>();
    const record = (name: string) => (payload: unknown) => {
      const list = events.get(name) ?? [];
      list.push(payload);
      events.set(name, list);
    };
    for (const name of [
      'session.snapshot',
      'question.opened',
      'question.closed',
      'session.state_changed',
      'session.closed',
      'counts.updated',
      'result.updated',
      'error',
    ]) {
      socket.on(name, record(name));
    }
    return { events };
  }

  function nextEvent(
    socket: ClientSocket,
    name: string,
    timeoutMs = 1500,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(name, handler);
        reject(new Error(`timeout waiting for ${name}`));
      }, timeoutMs);
      const handler = (payload: unknown) => {
        clearTimeout(timer);
        socket.off(name, handler);
        resolve(payload);
      };
      socket.once(name, handler);
    });
  }

  beforeAll(async () => {
    try {
      setupTestDb();
      migrationsReady = true;
    } catch {
      // Keep the suite blocked when migration setup fails.
    }
    app = await createTestApp();
    httpServer = app.getHttpServer();
    await app.listen(0); // ephemeral port
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
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
    const setCookie =
      (response.headers['set-cookie'] as unknown as string[]) ?? [];
    return {
      agent: agent as unknown as request.SuperAgentTest,
      csrfToken: cookieValue(setCookie, '__Host-csrf'),
      sessionCookie: cookieValue(setCookie, SESSION_COOKIE_NAME),
    };
  }

  async function adminStepUp(admin: AuthenticatedAgent): Promise<void> {
    const res = await admin.agent
      .post('/api/v1/auth/step-up')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ password: ADMIN.password });
    expect(res.status).toBe(201);
  }

  /** Resolve the current session's accountId via GET /auth/session. */
  async function currentAccountId(auth: AuthenticatedAgent): Promise<string> {
    const res = await auth.agent.get('/api/v1/auth/session');
    expect(res.status).toBe(200);
    return res.body.data.accountId as string;
  }

  async function createTeacher(
    username: string,
    displayName: string,
    tempPassword: string,
    password: string,
  ): Promise<AuthenticatedAgent & { sessionCookie: string }> {
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
      .send({ currentPassword: tempPassword, newPassword: password });
    expect(changed.status).toBe(201);
    return (await loginAs(username, password)) as AuthenticatedAgent & {
      sessionCookie: string;
    };
  }

  async function createStudent(): Promise<{
    accountId: string;
    auth: AuthenticatedAgent & { sessionCookie: string };
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
      auth: (await loginAs(
        STUDENT.username,
        STUDENT.password,
      )) as AuthenticatedAgent & { sessionCookie: string },
    };
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for realtime e2e tests.',
      );
    }
  }

  async function setupActiveSession(startSession = true): Promise<{
    teacher: AuthenticatedAgent & { sessionCookie: string };
    courseId: string;
    liveSessionId: string;
    sessionCode: string;
    sessionQuestionId: string;
    optionRefs: { a: string; b: string; c: string };
  }> {
    const teacher = await createTeacher(
      TEACHER.username,
      TEACHER.displayName,
      TEACHER.tempPassword,
      TEACHER.password,
    );

    const courseResponse = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'RT Course', description: 'realtime slice' });
    expect(courseResponse.status).toBe(201);
    const courseId = courseResponse.body.data.id as string;

    const questionResponse = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '哪一個？',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
          { optionRef: 'c', text: 'C' },
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

    let sessionQuestionId = '';
    if (startSession) {
      const startResponse = await teacher.agent
        .post(`/api/v1/live-sessions/${liveSessionId}/start`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, teacher.csrfToken);
      expect(startResponse.status).toBe(201);
      sessionQuestionId = startResponse.body.data.sessionQuestions[0]
        .id as string;
    }

    return {
      teacher,
      courseId,
      liveSessionId,
      sessionCode,
      sessionQuestionId,
      optionRefs: { a: 'a', b: 'b', c: 'c' },
    };
  }

  async function joinParticipant(
    sessionCode: string,
    displayName: string,
  ): Promise<{ participantToken: string; participantId: string }> {
    const joinResponse = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${sessionCode}/join`)
      .send({ displayName });
    expect(joinResponse.status).toBe(201);
    return {
      participantToken: joinResponse.body.data.participantToken as string,
      participantId: joinResponse.body.data.participantId as string,
    };
  }

  function connectTeacher(
    liveSessionId: string,
    sessionCookie: string,
  ): ClientSocket {
    const socket = ioClient(`${baseUrl}/live`, {
      withCredentials: true,
      // Allow the polling handshake so extraHeaders (Cookie) are reliably sent;
      // socket.io upgrades to websocket after.
      extraHeaders: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      auth: { liveSessionId },
    });
    return socket;
  }

  function connectParticipant(
    sessionCode: string,
    participantToken: string,
  ): ClientSocket {
    const socket = ioClient(`${baseUrl}/live`, {
      transports: ['websocket'],
      auth: { participantToken, sessionCode },
    });
    return socket;
  }

  function connectStudent(
    liveSessionId: string,
    sessionCookie: string,
  ): ClientSocket {
    const socket = ioClient(`${baseUrl}/live`, {
      withCredentials: true,
      extraHeaders: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      auth: { liveSessionId },
    });
    return socket;
  }

  it('teacher connects and receives a session.snapshot with joined/voted counts', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    const socket = connectTeacher(ctx.liveSessionId, ctx.teacher.sessionCookie);
    try {
      const snapshot = (await nextEvent(socket, 'session.snapshot')) as {
        data: { liveSession: { joinedCount: number; votedCount: number } };
      };
      expect(snapshot.data.liveSession.joinedCount).toBe(0);
      expect(snapshot.data.liveSession.votedCount).toBe(0);
    } finally {
      socket.close();
    }
  });

  it('teacher opening a question emits question.opened + counts.updated', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    const socket = connectTeacher(ctx.liveSessionId, ctx.teacher.sessionCookie);
    await nextEvent(socket, 'session.snapshot');
    // Pre-register listeners BEFORE the mutation so the post-commit emit (which
    // fires synchronously after the REST response) is not lost.
    const openedPromise = nextEvent(socket, 'question.opened');
    const countsPromise = nextEvent(socket, 'counts.updated');
    try {
      const openResponse = await ctx.teacher.agent
        .post(
          `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/open`,
        )
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, ctx.teacher.csrfToken);
      expect(openResponse.status).toBe(201);

      const opened = (await openedPromise) as {
        data: { sessionQuestionId: string };
      };
      expect(opened.data.sessionQuestionId).toBe(ctx.sessionQuestionId);
      const counts = (await countsPromise) as {
        data: { joinedCount: number; votedCount: number };
      };
      expect(counts.data.votedCount).toBe(0);
    } finally {
      socket.close();
    }
  });

  it('participant connects and receives a learner snapshot without answers', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    await ctx.teacher.agent
      .post(
        `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);

    const p = await joinParticipant(ctx.sessionCode, 'p1');
    const socket = connectParticipant(ctx.sessionCode, p.participantToken);
    try {
      const snapshot = (await nextEvent(socket, 'session.snapshot')) as {
        data: { liveSession: { sessionQuestions: unknown[] } };
      };
      // Learner projection: at least the open question is visible; no answers.
      const json = JSON.stringify(snapshot);
      expect(json).not.toContain('isCorrect');
      expect(json).not.toContain('participantToken');
    } finally {
      socket.close();
    }
  });

  it('enrolled student cookie joins participant scope without counts.updated', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    const student = await createStudent();
    const enrollment = await ctx.teacher.agent
      .post(`/api/v1/courses/${ctx.courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(enrollment.status).toBe(201);

    const socket = connectStudent(
      ctx.liveSessionId,
      student.auth.sessionCookie,
    );
    const collector = collectEvents(socket);
    try {
      const snapshot = (await nextEvent(socket, 'session.snapshot')) as {
        data: {
          liveSession: {
            sessionQuestions: unknown[];
            joinedCount?: number;
            votedCount?: number;
          };
        };
      };
      expect(snapshot.data.liveSession.sessionQuestions).toEqual([]);
      expect(snapshot.data.liveSession.joinedCount).toBeUndefined();
      expect(snapshot.data.liveSession.votedCount).toBeUndefined();

      const openedPromise = nextEvent(socket, 'question.opened');
      const openResponse = await ctx.teacher.agent
        .post(
          `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/open`,
        )
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, ctx.teacher.csrfToken);
      expect(openResponse.status).toBe(201);
      await openedPromise;

      const resultPromise = nextEvent(socket, 'result.updated');
      const submitted = await student.auth.agent
        .post(`/api/v1/live-sessions/${ctx.liveSessionId}/submissions`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, student.auth.csrfToken)
        .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000599')
        .send({
          sessionQuestionId: ctx.sessionQuestionId,
          selectedOptionRefs: [ctx.optionRefs.a],
        });
      expect(submitted.status).toBe(201);

      const result = (await resultPromise) as {
        visibility: string;
        data: {
          sessionQuestionId: string;
          results: { totalResponses: number };
        };
      };
      expect(result.visibility).toBe('participant');
      expect(result.data.sessionQuestionId).toBe(ctx.sessionQuestionId);
      expect(result.data.results.totalResponses).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(collector.events.get('counts.updated')).toBeUndefined();
      expect(JSON.stringify(collector.events)).not.toContain('joinedCount');

      // Pre-register before close so the post-commit participant projection is observed.
      const closeResultPromise = nextEvent(socket, 'result.updated');
      const closeResponse = await ctx.teacher.agent
        .post(
          `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/close`,
        )
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, ctx.teacher.csrfToken);
      expect(closeResponse.status).toBe(201);

      const closeResult = (await closeResultPromise) as {
        visibility: string;
        data: {
          sessionQuestionId: string;
          results: { status: string; totalResponses: number };
        };
      };
      expect(closeResult.visibility).toBe('participant');
      expect(closeResult.data.sessionQuestionId).toBe(ctx.sessionQuestionId);
      expect(closeResult.data.results).toMatchObject({
        status: 'closed',
        totalResponses: 1,
      });
      const closeResultJson = JSON.stringify(closeResult);
      for (const field of [
        'participantId',
        'accountId',
        'displayName',
        'participantToken',
        'sessionCode',
        'joinedCount',
        'votedCount',
      ]) {
        expect(closeResultJson).not.toContain(field);
      }
      expect(closeResultJson).not.toContain(student.accountId);
      expect(closeResultJson).not.toContain(STUDENT.displayName);
      expect(closeResultJson).not.toContain(
        submitted.body.data.participantId as string,
      );
    } finally {
      socket.close();
    }
  });

  it('disconnects a student socket after enrollment removal before later events', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    const student = await createStudent();
    const enrollment = await ctx.teacher.agent
      .post(`/api/v1/courses/${ctx.courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(enrollment.status).toBe(201);

    const socket = connectStudent(
      ctx.liveSessionId,
      student.auth.sessionCookie,
    );
    try {
      await nextEvent(socket, 'session.snapshot');
      const disconnected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timeout waiting for student disconnect')),
          1500,
        );
        socket.once('disconnect', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      const removed = await ctx.teacher.agent
        .delete(
          `/api/v1/courses/${ctx.courseId}/enrollments/${student.accountId}`,
        )
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, ctx.teacher.csrfToken);
      expect(removed.status).toBe(200);

      // The next post-commit signal reauthorizes connected participant sockets
      // before broadcasting the event and disconnects the removed student.
      const opened = await ctx.teacher.agent
        .post(
          `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/open`,
        )
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, ctx.teacher.csrfToken);
      expect(opened.status).toBe(201);
      await disconnected;
    } finally {
      socket.close();
    }
  });

  it('participant submitting emits teacher + submitting-participant result.updated (vote-to-reveal)', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    const teacherSocket = connectTeacher(
      ctx.liveSessionId,
      ctx.teacher.sessionCookie,
    );
    await nextEvent(teacherSocket, 'session.snapshot');
    const openOpened = nextEvent(teacherSocket, 'question.opened');
    const openCounts = nextEvent(teacherSocket, 'counts.updated');
    await ctx.teacher.agent
      .post(
        `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    await openOpened;
    await openCounts;

    const p = await joinParticipant(ctx.sessionCode, 'p1');
    const participantSocket = connectParticipant(
      ctx.sessionCode,
      p.participantToken,
    );
    await nextEvent(participantSocket, 'session.snapshot');
    const participantCollector = collectEvents(participantSocket);

    // Pre-register before the submission mutation.
    const submitCounts = nextEvent(teacherSocket, 'counts.updated');
    const submitResult = nextEvent(teacherSocket, 'result.updated');

    await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${ctx.liveSessionId}/submissions`)
      .set('X-Participant-Token', p.participantToken)
      .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000501')
      .send({
        sessionQuestionId: ctx.sessionQuestionId,
        selectedOptionRefs: [ctx.optionRefs.a],
      });

    const counts = (await submitCounts) as {
      data: { joinedCount: number; votedCount: number };
    };
    expect(counts.data.joinedCount).toBe(1);
    expect(counts.data.votedCount).toBe(1);
    const result = (await submitResult) as {
      data: {
        sessionQuestionId: string;
        results: {
          totalResponses: number;
          options: Array<{ optionRef: string; count: number }>;
        };
      };
    };
    expect(result.data.sessionQuestionId).toBe(ctx.sessionQuestionId);
    expect(result.data.results.totalResponses).toBe(1);
    expect(result.data.results.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ optionRef: 'a', count: 1 }),
        expect.objectContaining({ optionRef: 'b', count: 0 }),
        expect.objectContaining({ optionRef: 'c', count: 0 }),
      ]),
    );

    // The submitting participant receives a vote-to-reveal participant-safe
    // result.updated (poll single has no correctness metrics to leak).
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(participantCollector.events.get('counts.updated')).toBeUndefined();
    const participantEventJson = JSON.stringify(participantCollector.events);
    expect(participantEventJson).not.toContain('joinedCount');
    expect(participantEventJson).not.toContain('votedCount');
    const participantResults =
      participantCollector.events.get('result.updated');
    expect(participantResults).toBeDefined();
    const participantResult = participantResults![0] as {
      data: { sessionQuestionId: string; results: { totalResponses: number } };
    };
    expect(participantResult.data.sessionQuestionId).toBe(
      ctx.sessionQuestionId,
    );
    expect(participantResult.data.results.totalResponses).toBe(1);

    teacherSocket.close();
    participantSocket.close();
  });

  it('teacher closing a question emits question.closed + result.updated (final aggregate)', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    const teacherSocket = connectTeacher(
      ctx.liveSessionId,
      ctx.teacher.sessionCookie,
    );
    await nextEvent(teacherSocket, 'session.snapshot');
    const openOpened = nextEvent(teacherSocket, 'question.opened');
    const openCounts = nextEvent(teacherSocket, 'counts.updated');
    await ctx.teacher.agent
      .post(
        `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    await openOpened;
    await openCounts;

    // Pre-register before the close mutation.
    const closedPromise = nextEvent(teacherSocket, 'question.closed');
    const closeResult = nextEvent(teacherSocket, 'result.updated');

    const closeResponse = await ctx.teacher.agent
      .post(
        `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/close`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    expect(closeResponse.status).toBe(201);

    const closed = (await closedPromise) as {
      data: { sessionQuestionId: string };
    };
    expect(closed.data.sessionQuestionId).toBe(ctx.sessionQuestionId);
    const result = (await closeResult) as {
      data: {
        sessionQuestionId: string;
        results: {
          status: string;
          totalResponses: number;
          options: Array<{ optionRef: string; count: number }>;
        };
      };
    };
    expect(result.data.sessionQuestionId).toBe(ctx.sessionQuestionId);
    expect(result.data.results).toMatchObject({
      status: 'closed',
      totalResponses: 0,
    });
    expect(result.data.results.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ optionRef: 'a', count: 0 }),
        expect.objectContaining({ optionRef: 'b', count: 0 }),
        expect.objectContaining({ optionRef: 'c', count: 0 }),
      ]),
    );
    teacherSocket.close();
  });

  it('invalid participant token is rejected before snapshot', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    const socket = connectParticipant(ctx.sessionCode, 'not-a-real-token');
    try {
      const error = (await nextEvent(socket, 'error', 2000)) as {
        code: string;
      };
      expect(error.code).toBe('UNAUTHORIZED');
    } finally {
      socket.close();
    }
  });

  it('unknown session code is rejected', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    const p = await joinParticipant(ctx.sessionCode, 'p1');
    const socket = connectParticipant('NO-SUCH-CODE', p.participantToken);
    try {
      const error = (await nextEvent(socket, 'error', 2000)) as {
        code: string;
      };
      // Unknown code → SESSION_NOT_JOINABLE from findByCode.
      expect(error.code).toBe('SESSION_NOT_JOINABLE');
    } finally {
      socket.close();
    }
  });

  it('non-owner teacher is rejected before room join', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    const other = await createTeacher(
      OTHER_TEACHER.username,
      OTHER_TEACHER.displayName,
      OTHER_TEACHER.tempPassword,
      OTHER_TEACHER.password,
    );
    const socket = connectTeacher(ctx.liveSessionId, other.sessionCookie);
    try {
      const error = (await nextEvent(socket, 'error', 2000)) as {
        code: string;
      };
      expect(error.code).toBe('UNAUTHORIZED');
    } finally {
      socket.close();
    }
  });

  it('cancelling a session emits session.state_changed; reconnect with the now-cancelled token is rejected', async () => {
    requireDatabase();
    const ctx = await setupActiveSession(false);
    const p = await joinParticipant(ctx.sessionCode, 'p1');
    const participantSocket = connectParticipant(
      ctx.sessionCode,
      p.participantToken,
    );
    await nextEvent(participantSocket, 'session.snapshot');
    // Pre-register before the mutation.
    const stateChangedPromise = nextEvent(
      participantSocket,
      'session.state_changed',
    );

    const cancelResponse = await ctx.teacher.agent
      .post(`/api/v1/live-sessions/${ctx.liveSessionId}/cancel`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken);
    expect(cancelResponse.status).toBe(201);

    const stateChanged = (await stateChangedPromise) as {
      data: { status: string };
    };
    expect(stateChanged.data.status).toBe('cancelled');
    participantSocket.close();

    // Reconnect with the now-cancelled session token must be rejected.
    const reconnect = connectParticipant(ctx.sessionCode, p.participantToken);
    try {
      const error = (await nextEvent(reconnect, 'error', 2000)) as {
        code: string;
      };
      expect(error.code).toBe('SESSION_NOT_JOINABLE');
    } finally {
      reconnect.close();
    }
  });

  it('disconnects a teacher socket when its account is disabled (US-F8)', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    const socket = connectTeacher(ctx.liveSessionId, ctx.teacher.sessionCookie);
    try {
      await nextEvent(socket, 'session.snapshot');
      // Pre-register the disconnect promise BEFORE the disable mutation so the
      // post-commit lifecycle signal is not missed.
      const disconnected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timeout waiting for teacher disconnect')),
          2000,
        );
        socket.once('disconnect', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      const admin = await loginAs(ADMIN.username, ADMIN.password);
      await adminStepUp(admin);
      const teacherAccountId = await currentAccountId(ctx.teacher);
      const disable = await admin.agent
        .post(`/api/v1/admin/accounts/${teacherAccountId}/disable`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, admin.csrfToken);
      expect(disable.status).toBe(201);

      await disconnected;
    } finally {
      socket.close();
    }
  });

  it('disconnects an account-bound student socket when the account is disabled (US-F8)', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    const student = await createStudent();
    const enrollment = await ctx.teacher.agent
      .post(`/api/v1/courses/${ctx.courseId}/enrollments`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, ctx.teacher.csrfToken)
      .send({ studentAccountId: student.accountId });
    expect(enrollment.status).toBe(201);

    const socket = connectStudent(
      ctx.liveSessionId,
      student.auth.sessionCookie,
    );
    try {
      await nextEvent(socket, 'session.snapshot');
      const disconnected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timeout waiting for student disconnect')),
          2000,
        );
        socket.once('disconnect', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      const admin = await loginAs(ADMIN.username, ADMIN.password);
      await adminStepUp(admin);
      const disable = await admin.agent
        .post(`/api/v1/admin/accounts/${student.accountId}/disable`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, admin.csrfToken);
      expect(disable.status).toBe(201);

      await disconnected;
    } finally {
      socket.close();
    }
  });

  it('keeps an anonymous participant socket connected when an account is disabled (US-F8)', async () => {
    requireDatabase();
    const ctx = await setupActiveSession();
    const otherTeacher = await createTeacher(
      OTHER_TEACHER.username,
      OTHER_TEACHER.displayName,
      OTHER_TEACHER.tempPassword,
      OTHER_TEACHER.password,
    );

    const p = await joinParticipant(ctx.sessionCode, 'anonymous');
    const socket = connectParticipant(ctx.sessionCode, p.participantToken);
    try {
      await nextEvent(socket, 'session.snapshot');
      // Disabling an unrelated teacher account must NOT affect the anonymous
      // participant socket — its credential is account-independent.
      const admin = await loginAs(ADMIN.username, ADMIN.password);
      await adminStepUp(admin);
      const otherTeacherAccountId = await currentAccountId(otherTeacher);
      const disable = await admin.agent
        .post(`/api/v1/admin/accounts/${otherTeacherAccountId}/disable`)
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, admin.csrfToken);
      expect(disable.status).toBe(201);

      // Still connected and still receiving session events.
      const openedPromise = nextEvent(socket, 'question.opened');
      await ctx.teacher.agent
        .post(
          `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/open`,
        )
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, ctx.teacher.csrfToken);
      const opened = (await openedPromise) as {
        data: { sessionQuestionId: string };
      };
      expect(opened.data.sessionQuestionId).toBe(ctx.sessionQuestionId);
    } finally {
      socket.close();
    }
  });

  it.each([
    ['LiveSessionService open', 'open'],
    ['ParticipantService join', 'join'],
    ['SubmissionService submit', 'submit'],
  ])('%s publishes only after its transaction commits', async (_name, path) => {
    requireDatabase();
    const bus = app.get(LiveSessionEventBus);
    let publishObserved: Promise<void> | undefined;
    const publish = jest
      .spyOn(bus, 'publish')
      .mockImplementation(async (signal) => {
        publishObserved = (async () => {
          if (signal.type === 'question.opened') {
            const row = await prisma.prisma.sessionQuestion.findUnique({
              where: { id: signal.sessionQuestionId },
            });
            expect(row?.status).toBe('open');
          } else if (signal.type === 'participant.joined') {
            const row = await prisma.prisma.participant.findUnique({
              where: { id: signal.participantId },
            });
            expect(row).not.toBeNull();
          } else if (signal.type === 'submission.committed') {
            const row = await prisma.prisma.submission.findFirst({
              where: {
                participantId: signal.participantId,
                sessionQuestionId: signal.sessionQuestionId,
              },
            });
            expect(row).not.toBeNull();
          }
        })();
        await publishObserved;
      });
    try {
      if (path === 'open') {
        const ctx = await setupActiveSession();
        const response = await ctx.teacher.agent
          .post(
            `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/open`,
          )
          .set('Origin', TEST_ORIGIN)
          .set(CSRF_HEADER, ctx.teacher.csrfToken);
        expect(response.status).toBe(201);
      } else if (path === 'join') {
        const ctx = await setupActiveSession(false);
        const response = await request(app.getHttpServer())
          .post(`/api/v1/live-sessions/${ctx.sessionCode}/join`)
          .send({ displayName: 'p1' });
        expect(response.status).toBe(201);
      } else {
        const ctx = await setupActiveSession();
        await ctx.teacher.agent
          .post(
            `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/open`,
          )
          .set('Origin', TEST_ORIGIN)
          .set(CSRF_HEADER, ctx.teacher.csrfToken);
        const participant = await joinParticipant(ctx.sessionCode, 'p1');
        const response = await request(app.getHttpServer())
          .post(`/api/v1/live-sessions/${ctx.liveSessionId}/submissions`)
          .set('X-Participant-Token', participant.participantToken)
          .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000601')
          .send({
            sessionQuestionId: ctx.sessionQuestionId,
            selectedOptionRefs: [ctx.optionRefs.a],
          });
        expect(response.status).toBe(201);
      }
      await publishObserved;
    } finally {
      publish.mockRestore();
    }
  });

  it('publisher rejection does not fail or roll back representative mutations', async () => {
    requireDatabase();
    const bus = app.get(LiveSessionEventBus);
    const publish = jest
      .spyOn(bus, 'publish')
      .mockRejectedValue(new Error('publisher unavailable'));
    try {
      const ctx = await setupActiveSession();
      const joined = await request(app.getHttpServer())
        .post(`/api/v1/live-sessions/${ctx.sessionCode}/join`)
        .send({ displayName: 'p1' });
      expect(joined.status).toBe(201);
      const participant = await prisma.prisma.participant.findUnique({
        where: { id: joined.body.data.participantId },
      });
      expect(participant).not.toBeNull();
      const opened = await ctx.teacher.agent
        .post(
          `/api/v1/live-sessions/${ctx.liveSessionId}/questions/${ctx.sessionQuestionId}/open`,
        )
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, ctx.teacher.csrfToken);
      expect(opened.status).toBe(201);
      const question = await prisma.prisma.sessionQuestion.findUnique({
        where: { id: ctx.sessionQuestionId },
      });
      expect(question?.status).toBe('open');
      const submitted = await request(app.getHttpServer())
        .post(`/api/v1/live-sessions/${ctx.liveSessionId}/submissions`)
        .set('X-Participant-Token', joined.body.data.participantToken)
        .set('Idempotency-Key', '0190c6b8-0000-7000-8000-000000000602')
        .send({
          sessionQuestionId: ctx.sessionQuestionId,
          selectedOptionRefs: [ctx.optionRefs.a],
        });
      expect(submitted.status).toBe(201);
      const submission = await prisma.prisma.submission.findFirst({
        where: {
          participantId: joined.body.data.participantId,
          sessionQuestionId: ctx.sessionQuestionId,
        },
      });
      expect(submission).not.toBeNull();
    } finally {
      publish.mockRestore();
    }
  });
});
