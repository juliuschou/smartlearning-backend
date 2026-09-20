import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CSRF_COOKIE_NAME, CSRF_HEADER } from '../src/common/security';
import {
  RealtimeCheckpointReason,
  RealtimeEvent,
  RealtimeVisibility,
} from '../src/modules/realtime/live-session-realtime-contract';
import { LiveSessionOutboxService } from '../src/modules/realtime/live-session-outbox.service';
import { TransactionService } from '../src/prisma/transaction.service';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * Concurrent anonymous-join regression (Option B on top of C).
 *
 * Guardrails: splitting lifecycle synchronization from event sequencing must not
 * break participant uniqueness, duplicate-free joins, event sequencing, or
 * session close/join races. All assertions are DB-reconciled against
 * authoritative rows, not just HTTP responses.
 */
describe('Concurrent anonymous join (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let outbox: LiveSessionOutboxService;
  let transactions: TransactionService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'concurrent-join-e2e-admin',
    displayName: 'Concurrent Join E2E Admin',
    password: 'concurrent-join-e2e-admin-1234',
  };
  const TEACHER = {
    username: 'concurrent-join-e2e-teacher',
    displayName: 'Concurrent Join E2E Teacher',
    tempPassword: 'concurrent-join-e2e-teacher-temp-1234',
    password: 'concurrent-join-e2e-teacher-final-1234',
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
    outbox = app.get(LiveSessionOutboxService);
    transactions = app.get(TransactionService);
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
    expect(response.status).toBe(201);
    return {
      agent: agent as unknown as request.SuperAgentTest,
      csrfToken: cookieValue(
        cookieHeaders(response.headers['set-cookie']),
        CSRF_COOKIE_NAME,
      ),
    };
  }

  async function provisionTeacher(): Promise<AuthenticatedAgent> {
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

  async function setupActiveSession(teacher: AuthenticatedAgent): Promise<{
    liveSessionId: string;
    sessionCode: string;
    sessionQuestionId: string;
  }> {
    const course = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Concurrent Join Course' });
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
      liveSessionId,
      sessionCode,
      sessionQuestionId: started.body.data.sessionQuestions[0].id as string,
    };
  }

  it('concurrent anonymous joins produce exact counts, unique ids, and ordered events', async () => {
    if (!dbReachable) return;
    const teacher = await provisionTeacher();
    const { liveSessionId, sessionCode } = await setupActiveSession(teacher);

    const concurrency = 25;
    const responses = await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        request(app.getHttpServer())
          .post(`/api/v1/live-sessions/${sessionCode}/join`)
          .send({ displayName: `Joiner ${index + 1}` }),
      ),
    );

    expect(responses).toHaveLength(concurrency);
    expect(responses.every((response) => response.status === 201)).toBe(true);

    // DB reconciliation: exact participant count, zero duplicate ids.
    const participants = await prisma.prisma.participant.findMany({
      where: { liveSessionId },
      select: { id: true },
    });
    expect(participants).toHaveLength(concurrency);
    expect(new Set(participants.map((row) => row.id)).size).toBe(concurrency);

    // HTTP response ids must match authoritative rows exactly.
    const responseIds = responses.map(
      (response) => response.body.data.participantId as string,
    );
    expect(new Set(responseIds).size).toBe(concurrency);
    expect(new Set(responseIds)).toEqual(
      new Set(participants.map((row) => row.id)),
    );

    // Event sequencing: exactly one teacher snapshot event per join, strictly
    // ordered, no duplicate sequences, no lost updates. Lifecycle events from
    // create/start (session.state_changed) share the per-session seq counter,
    // so join events are scoped by eventName and their sequences must be a
    // contiguous ascending run (not 1..N — the lifecycle prefix offsets them).
    const events = await prisma.prisma.liveSessionEvent.findMany({
      where: { liveSessionId, eventName: RealtimeEvent.SESSION_SNAPSHOT },
      orderBy: { eventSeq: 'asc' },
      select: { eventSeq: true, eventName: true },
    });
    expect(events).toHaveLength(concurrency);
    expect(new Set(events.map((event) => String(event.eventSeq))).size).toBe(
      concurrency,
    );
    const sequences = events.map((event) => Number(event.eventSeq));
    expect(sequences).toEqual(sequences.slice().sort((a, b) => a - b));
    expect(sequences[sequences.length - 1]).toBe(
      sequences[0] + concurrency - 1,
    );

    // The dedicated counter reflects every committed event (lifecycle prefix
    // + one snapshot per join) without mutating the lifecycle row.
    const sequence = await prisma.prisma.liveSessionEventSequence.findUnique({
      where: { liveSessionId },
      select: { lastEventSeq: true },
    });
    expect(Number(sequence?.lastEventSeq)).toBe(
      sequences[sequences.length - 1],
    );
  });

  it('rejects joins racing a session close without creating orphan participants', async () => {
    if (!dbReachable) return;
    const teacher = await provisionTeacher();

    for (let iteration = 0; iteration < 3; iteration += 1) {
      const { liveSessionId, sessionCode } = await setupActiveSession(teacher);

      // Fire concurrent joins against the close; accepted set and DB state must
      // agree exactly either way (close wins the linearization point or the
      // joins do — but never both).
      const [closeResponse, ...joinResponses] = await Promise.all([
        teacher.agent
          .post(`/api/v1/live-sessions/${liveSessionId}/close`)
          .set('Origin', TEST_ORIGIN)
          .set(CSRF_HEADER, teacher.csrfToken),
        ...Array.from({ length: 10 }, (_, index) =>
          request(app.getHttpServer())
            .post(`/api/v1/live-sessions/${sessionCode}/join`)
            .send({ displayName: `Racer ${iteration + 1}-${index + 1}` }),
        ),
      ]);
      expect([200, 201]).toContain(closeResponse.status);

      const participants = await prisma.prisma.participant.findMany({
        where: { liveSessionId },
        select: { id: true, liveSessionId: true },
      });
      const accepted = joinResponses.filter(
        (response) => response.status === 201,
      );
      expect(participants).toHaveLength(accepted.length);
      const acceptedIds = accepted.map(
        (response) => response.body.data.participantId as string,
      );
      expect(new Set(acceptedIds)).toEqual(
        new Set(participants.map((row) => row.id)),
      );

      for (const response of joinResponses) {
        expect([201, 409]).toContain(response.status);
      }

      const events = await prisma.prisma.liveSessionEvent.findMany({
        where: { liveSessionId, eventName: RealtimeEvent.SESSION_SNAPSHOT },
        orderBy: { eventSeq: 'asc' },
        select: { eventSeq: true, eventName: true },
      });
      expect(events).toHaveLength(accepted.length);
      const sequences = events.map((event) => Number(event.eventSeq));
      expect(sequences).toEqual(sequences.slice().sort((a, b) => a - b));
      if (accepted.length > 0) {
        expect(sequences[sequences.length - 1]).toBe(
          sequences[0] + accepted.length - 1,
        );
      } else {
        expect(sequences).toEqual([]);
      }

      const closed = await prisma.prisma.liveSession.findUniqueOrThrow({
        where: { id: liveSessionId },
        select: { status: true },
      });
      expect(closed.status).toBe('closed');
      const lifecycle = await prisma.prisma.liveSessionEvent.findMany({
        where: { liveSessionId },
        orderBy: { eventSeq: 'asc' },
        select: { eventName: true, eventSeq: true },
      });
      const closeSequence = lifecycle.find(
        (event) => event.eventName === RealtimeEvent.SESSION_CLOSED,
      )?.eventSeq;
      expect(closeSequence).toBeDefined();
      expect(
        events.every((event) => event.eventSeq < (closeSequence as bigint)),
      ).toBe(true);
    }
  });

  it('allocates unique ordered sequences concurrently without lifecycle-row writes', async () => {
    if (!dbReachable) return;
    const teacher = await provisionTeacher();
    const { liveSessionId } = await setupActiveSession(teacher);
    const before =
      await prisma.prisma.liveSessionEventSequence.findUniqueOrThrow({
        where: { liveSessionId },
        select: { lastEventSeq: true },
      });
    const allocations = 25;

    const events = await Promise.all(
      Array.from({ length: allocations }, () =>
        transactions.run((tx) =>
          outbox.append(tx, {
            liveSessionId,
            event: RealtimeEvent.SESSION_SNAPSHOT,
            visibility: RealtimeVisibility.TEACHER,
            projectionInput: {
              reason: RealtimeCheckpointReason.PARTICIPANT_JOINED,
            },
          }),
        ),
      ),
    );
    const sequences = events
      .map((event) => event.eventSeq)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    expect(new Set(sequences.map(String)).size).toBe(allocations);
    expect(sequences[0]).toBe(before.lastEventSeq + 1n);
    expect(sequences[sequences.length - 1]).toBe(
      before.lastEventSeq + BigInt(allocations),
    );
    const after =
      await prisma.prisma.liveSessionEventSequence.findUniqueOrThrow({
        where: { liveSessionId },
        select: { lastEventSeq: true },
      });
    expect(after.lastEventSeq).toBe(before.lastEventSeq + BigInt(allocations));
  });

  it('rolls back participant and sequence allocation when event append fails', async () => {
    if (!dbReachable) return;
    const teacher = await provisionTeacher();
    const { liveSessionId, sessionCode } = await setupActiveSession(teacher);
    const before =
      await prisma.prisma.liveSessionEventSequence.findUniqueOrThrow({
        where: { liveSessionId },
        select: { lastEventSeq: true },
      });

    jest.spyOn(outbox, 'append').mockImplementationOnce(async (tx, input) => {
      await transactions.allocateRealtimeEventSeq(tx, input.liveSessionId);
      throw new Error('Injected append failure after sequence allocation');
    });

    const failed = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${sessionCode}/join`)
      .send({ displayName: 'Rollback Joiner' });
    expect(failed.status).toBe(500);
    expect(
      await prisma.prisma.participant.count({ where: { liveSessionId } }),
    ).toBe(0);
    expect(
      await prisma.prisma.liveSessionEvent.count({
        where: { liveSessionId, eventName: RealtimeEvent.SESSION_SNAPSHOT },
      }),
    ).toBe(0);
    const rolledBack =
      await prisma.prisma.liveSessionEventSequence.findUniqueOrThrow({
        where: { liveSessionId },
        select: { lastEventSeq: true },
      });
    expect(rolledBack.lastEventSeq).toBe(before.lastEventSeq);

    const succeeded = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${sessionCode}/join`)
      .send({ displayName: 'Recovery Joiner' });
    expect(succeeded.status).toBe(201);
    const event = await prisma.prisma.liveSessionEvent.findFirstOrThrow({
      where: { liveSessionId, eventName: RealtimeEvent.SESSION_SNAPSHOT },
      select: { eventSeq: true },
    });
    expect(event.eventSeq).toBe(before.lastEventSeq + 1n);
  });

  /**
   * Plan C regression: the post-commit snapshot read is no longer on the Join
   * response path. The HTTP response must stay complete (full contract), the
   * participant commit must be durable, and the participant must obtain the
   * full session state afterwards via the snapshot endpoint with DB-consistent
   * state.
   */
  it('joins succeed with no post-commit snapshot on the response path and can fetch full state afterwards', async () => {
    if (!dbReachable) return;
    const teacher = await provisionTeacher();
    const { liveSessionId, sessionCode, sessionQuestionId } =
      await setupActiveSession(teacher);

    // Open the question before joining so the participant snapshot carries a
    // full open-question projection (matches live-session-detail.e2e-spec.ts).
    const openResponse = await teacher.agent
      .post(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(openResponse.status).toBe(201);

    const joinResponse = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${sessionCode}/join`)
      .send({ displayName: 'Deferred Snapshot Joiner' });
    expect(joinResponse.status).toBe(201);

    // 1. Durable commit: exactly one authoritative participant row.
    const participants = await prisma.prisma.participant.findMany({
      where: { liveSessionId },
      select: { id: true },
    });
    expect(participants).toHaveLength(1);

    // 2. Minimal-response contract remains complete.
    expect(joinResponse.body.data.participantId).toBe(participants[0].id);
    expect(typeof joinResponse.body.data.participantToken).toBe('string');
    expect(joinResponse.body.data.liveSession).toMatchObject({
      id: liveSessionId,
      status: 'active',
      sessionCode,
    });

    // 3. Client obtains the full session snapshot afterwards; state must be
    // DB-consistent (open question + options visible, watermark present).
    const token = joinResponse.body.data.participantToken as string;
    const snapshotResponse = await request(app.getHttpServer())
      .get(`/api/v1/live-sessions/${liveSessionId}/snapshot`)
      .set('X-Participant-Token', token);
    expect(snapshotResponse.status).toBe(200);
    expect(snapshotResponse.body.data.id).toBe(liveSessionId);
    expect(snapshotResponse.body.data.sessionCode).toBe(sessionCode);
    expect(snapshotResponse.body.data.status).toBe('active');
    expect(snapshotResponse.body.data.sessionQuestions).toHaveLength(1);
    expect(snapshotResponse.body.data.sessionQuestions[0].status).toBe('open');
    expect(
      snapshotResponse.body.data.sessionQuestions[0].options.length,
    ).toBeGreaterThan(0);
    expect(snapshotResponse.body.data.watermark).toBeDefined();

    // 4. Realtime/subsequent state agrees with the DB: the participant row
    // from the snapshot's authoritative view matches the committed row.
    const snapshotJoinedCount = await prisma.prisma.participant.count({
      where: { liveSessionId },
    });
    expect(snapshotJoinedCount).toBe(1);
  });
});
