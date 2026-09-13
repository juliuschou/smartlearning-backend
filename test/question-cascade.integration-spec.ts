import type { INestApplication } from '@nestjs/common';
import { newId } from '../src/common/crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  QuestionService,
  type QuestionWithOptions,
} from '../src/modules/questions/application/question.service';
import { LiveSessionService } from '../src/modules/live-sessions/application/live-session.service';
import type { CreateQuestionDto } from '../src/modules/questions/api/dto';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';
import { LiveSessionStatus } from '../src/modules/live-sessions/domain/live-session-status';
import { SessionQuestionStatus } from '../src/modules/live-sessions/domain/session-question-status';

/**
 * BE-3.1.2 CP2 evidence — question cascade and no-reopen.
 *
 * Fills the DB-backed gaps not yet asserted at the service level (the domain
 * predicates live in live-session-status.spec.ts). The one-open-at-a-time
 * invariant relies on the PostgreSQL partial unique index
 * `uq_session_question_one_open ON session_question(live_session_id)
 * WHERE status='open'` (migration 20260816120000), so at most one OPEN row per
 * session exists and the multi-question cascade proves one open question
 * closes while its not_open sibling stays untouched and zero OPEN remain.
 */
describe('LiveSession question cascade & no-reopen (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let questions: QuestionService;
  let sessions: LiveSessionService;
  let dbReachable = false;
  let migrationsReady = false;

  const caller = {
    id: '0190c6b8-0000-7000-8000-000000000401',
    role: 'teacher',
  };

  beforeAll(async () => {
    try {
      setupTestDb();
      migrationsReady = true;
    } catch {
      // Keep the suite blocked when any migration fails; do not probe stale schema.
    }
    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    questions = app.get(QuestionService);
    sessions = app.get(LiveSessionService);
    if (!migrationsReady) return;
    try {
      await prisma.prisma.$queryRaw`SELECT 1 FROM session_question LIMIT 0`;
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    if (dbReachable)
      await withQuiescedLiveSessionPublisher(app, () =>
        truncateAll(prisma.prisma),
      );
  });

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for question-cascade integration tests.',
      );
    }
  }

  async function createCourse(): Promise<string> {
    const account = await prisma.prisma.account.create({
      data: {
        id: caller.id,
        username: `cascade-teacher-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        displayName: 'Cascade Teacher',
        role: caller.role,
        canCreateCourse: true,
      },
    });
    const course = await prisma.prisma.course.create({
      data: {
        id: newId(),
        ownerAccountId: account.id,
        name: 'Cascade Course',
        status: 'draft',
      },
    });
    return course.id;
  }

  function pollDto(prompt: string): CreateQuestionDto {
    return {
      type: 'poll',
      prompt,
      selectionMode: 'single',
      options: [
        { optionRef: 'source', text: 'Source data' },
        { optionRef: 'bias', text: 'Sample bias' },
      ],
    };
  }

  /** Build a started session with `count` questions and return both. */
  async function createStartedSession(count: number) {
    const courseId = await createCourse();
    const sourceQuestions: QuestionWithOptions[] = [];
    for (let index = 0; index < count; index += 1) {
      sourceQuestions.push(
        await questions.createQuestion(
          courseId,
          caller,
          pollDto(`Q ${index + 1}`),
        ),
      );
    }
    const waiting = await sessions.createSession(
      { courseId, questionIds: sourceQuestions.map((q) => q.id) },
      caller,
    );
    const active = await sessions.startSession(waiting.id, caller);
    const sessionQuestions = active.questions.map((q) => ({
      sessionQuestionId: q.id,
      sourceQuestionId: q.questionDefinitionId,
    }));
    return { courseId, sourceQuestions, waiting, active, sessionQuestions };
  }

  function assertRejected(
    promise: Promise<unknown>,
    assertion: (reason: unknown) => void,
  ): Promise<void> {
    return promise.then(() => {
      throw new Error('Expected the operation to be rejected.');
    }, assertion);
  }

  it('enforces one open question per session via the partial-unique-index P2002 translation', async () => {
    requireDatabase();
    const { active, sessionQuestions } = await createStartedSession(2);
    const first = sessionQuestions[0].sessionQuestionId;
    const second = sessionQuestions[1].sessionQuestionId;

    const opened = await sessions.openQuestion(active.id, first, caller);
    expect(opened.status).toBe(SessionQuestionStatus.OPEN);

    await assertRejected(
      sessions.openQuestion(active.id, second, caller),
      (reason) => {
        // The exact message is only emitted by the P2002 catch, which proves
        // the partial unique index fired rather than a generic state guard.
        expect(reason).toMatchObject({
          code: 'CONFLICT',
          message: 'Only one SessionQuestion may be open at a time.',
        });
      },
    );

    const firstRow = await prisma.prisma.sessionQuestion.findUniqueOrThrow({
      where: { id: first },
      select: { status: true },
    });
    const secondRow = await prisma.prisma.sessionQuestion.findUniqueOrThrow({
      where: { id: second },
      select: { status: true },
    });
    expect(firstRow.status).toBe(SessionQuestionStatus.OPEN);
    expect(secondRow.status).toBe(SessionQuestionStatus.NOT_OPEN);
  });

  it('rejects a repeated close of the same open question while the session stays active', async () => {
    requireDatabase();
    const { active, sessionQuestions } = await createStartedSession(1);
    const questionId = sessionQuestions[0].sessionQuestionId;

    await sessions.openQuestion(active.id, questionId, caller);
    const closed = await sessions.closeQuestion(active.id, questionId, caller);
    expect(closed.status).toBe(SessionQuestionStatus.CLOSED);

    await assertRejected(
      sessions.closeQuestion(active.id, questionId, caller),
      (reason) => {
        expect(reason).toMatchObject({ code: 'CONFLICT' });
      },
    );

    const row = await prisma.prisma.sessionQuestion.findUniqueOrThrow({
      where: { id: questionId },
      select: { status: true, closedAt: true },
    });
    expect(row.status).toBe(SessionQuestionStatus.CLOSED);
    expect(row.closedAt).not.toBeNull();
  });

  it('rejects reopening a closed question while the session stays active', async () => {
    requireDatabase();
    const { active, sessionQuestions } = await createStartedSession(1);
    const questionId = sessionQuestions[0].sessionQuestionId;

    await sessions.openQuestion(active.id, questionId, caller);
    await sessions.closeQuestion(active.id, questionId, caller);

    // Distinct from terminal-matrix: the session is STILL ACTIVE here, so this
    // exercises canOpenSessionQuestion(CLOSED), not the non-active guard.
    await assertRejected(
      sessions.openQuestion(active.id, questionId, caller),
      (reason) => {
        expect(reason).toMatchObject({ code: 'CONFLICT' });
      },
    );

    const row = await prisma.prisma.sessionQuestion.findUniqueOrThrow({
      where: { id: questionId },
      select: { status: true },
    });
    expect(row.status).toBe(SessionQuestionStatus.CLOSED);
  });

  it('cascades session close to the open question with traceable closedAt, no leftover open row', async () => {
    requireDatabase();
    const { active, sessionQuestions } = await createStartedSession(2);
    const first = sessionQuestions[0].sessionQuestionId;
    const second = sessionQuestions[1].sessionQuestionId;

    await sessions.openQuestion(active.id, first, caller);

    const closed = await sessions.closeSession(active.id, caller);
    expect(closed.status).toBe(LiveSessionStatus.CLOSED);
    expect(closed.closedAt).not.toBeNull();

    const rows = await prisma.prisma.sessionQuestion.findMany({
      where: { liveSessionId: active.id },
      orderBy: { position: 'asc' },
      select: { id: true, status: true, closedAt: true },
    });
    expect(rows).toHaveLength(2);
    const firstRow = rows.find((row) => row.id === first);
    const secondRow = rows.find((row) => row.id === second);
    expect(firstRow?.status).toBe(SessionQuestionStatus.CLOSED);
    // Traceable: the cascaded question shares the session's closedAt.
    expect(firstRow?.closedAt?.getTime()).toBe(closed.closedAt?.getTime());
    // The not_open sibling is untouched by the cascade.
    expect(secondRow?.status).toBe(SessionQuestionStatus.NOT_OPEN);
    expect(secondRow?.closedAt).toBeNull();
    expect(
      rows.filter((row) => row.status === SessionQuestionStatus.OPEN),
    ).toHaveLength(0);

    const openCount = await prisma.prisma.sessionQuestion.count({
      where: { liveSessionId: active.id, status: SessionQuestionStatus.OPEN },
    });
    expect(openCount).toBe(0);

    // One question.closed event for the cascaded open question; one session.closed.
    const questionClosed = await prisma.prisma.liveSessionEvent.count({
      where: { liveSessionId: active.id, eventName: 'question.closed' },
    });
    const sessionClosed = await prisma.prisma.liveSessionEvent.count({
      where: { liveSessionId: active.id, eventName: 'session.closed' },
    });
    expect(questionClosed).toBe(1);
    expect(sessionClosed).toBe(1);
  });

  it('rejects question close on a non-active (closed) session', async () => {
    requireDatabase();
    const { active, sessionQuestions } = await createStartedSession(1);
    const questionId = sessionQuestions[0].sessionQuestionId;

    await sessions.openQuestion(active.id, questionId, caller);
    await sessions.closeSession(active.id, caller);

    await assertRejected(
      sessions.closeQuestion(active.id, questionId, caller),
      (reason) => {
        // Both the session-active guard and canCloseSessionQuestion(CLOSED)
        // apply; the non-active guard fires first at transitionQuestion:1413.
        expect(reason).toMatchObject({ code: 'CONFLICT' });
      },
    );
  });
});
