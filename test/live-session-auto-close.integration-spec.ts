import type { INestApplication } from '@nestjs/common';
import { newId } from '../src/common/crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { QuestionService } from '../src/modules/questions/application/question.service';
import { LiveSessionService } from '../src/modules/live-sessions/application/live-session.service';
import type { CreateQuestionDto } from '../src/modules/questions/api/dto';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';
import { LiveSessionStatus } from '../src/modules/live-sessions/domain/live-session-status';
import { SessionQuestionStatus } from '../src/modules/live-sessions/domain/session-question-status';

describe('LiveSession auto-close (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let questions: QuestionService;
  let sessions: LiveSessionService;
  let dbReachable = false;
  let migrationsReady = false;

  /** A fixed epoch anchor so all controlled-`now` assertions are deterministic. */
  const BASE_NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

  const caller = {
    id: '0190c6b8-0000-7000-8000-000000000201',
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
      await prisma.prisma.$queryRaw`SELECT 1 FROM live_session LIMIT 0`;
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
        'BLOCKED: PostgreSQL migration/schema is unavailable for auto-close integration tests.',
      );
    }
  }

  /**
   * Build an active LiveSession whose `startedAt` is backdated by `ageMs` from
   * the anchor, so the controlled clock can decide whether the 8h sweep matches.
   */
  async function createBackdatedActiveSession(ageMs: number) {
    const account = await prisma.prisma.account.create({
      data: {
        id: caller.id,
        username: `autoclose-teacher-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        displayName: 'Auto-close Teacher',
        role: caller.role,
        canCreateCourse: true,
      },
    });
    const course = await prisma.prisma.course.create({
      data: {
        id: newId(),
        ownerAccountId: account.id,
        name: 'Auto-close Course',
        status: 'draft',
      },
    });

    const dto: CreateQuestionDto = {
      type: 'poll',
      prompt: 'Which matters?',
      selectionMode: 'single',
      options: [
        { optionRef: 'source', text: 'Source data' },
        { optionRef: 'bias', text: 'Sample bias' },
        { optionRef: 'causality', text: 'Causality' },
      ],
    };
    const sourceQuestion = await questions.createQuestion(
      course.id,
      caller,
      dto,
    );

    const waiting = await sessions.createSession(
      { courseId: course.id, questionIds: [sourceQuestion.id] },
      caller,
    );
    const active = await sessions.startSession(waiting.id, caller);
    const questionId = active.questions[0].id;

    // Open the question so the sweep has an OPEN question to cascade onto close.
    await sessions.openQuestion(active.id, questionId, caller);

    // Backdate startedAt so the sweep cutoff (now - 8h) falls after it.
    const startedAt = new Date(BASE_NOW_MS - ageMs);
    await prisma.prisma.liveSession.update({
      where: { id: active.id },
      data: { startedAt },
    });

    // Confirm the session question is in the OPEN state, ready to cascade.
    const sessionQuestion =
      await prisma.prisma.sessionQuestion.findUniqueOrThrow({
        where: { id: questionId },
        select: { status: true },
      });
    expect(sessionQuestion.status).toBe(SessionQuestionStatus.OPEN);

    return { account, course, waiting, active, questionId };
  }

  it('BE-6.5: closes an expired session, cascades its open question, and records autoClosed=true', async () => {
    requireDatabase();
    // 9h old — comfortably beyond the 8h hard limit.
    const scenario = await createBackdatedActiveSession(9 * 60 * 60 * 1000);
    const controlledNow = new Date(BASE_NOW_MS);

    const closed = await sessions.autoCloseExpiredSessions(controlledNow);

    expect(closed).toBe(1);
    const terminal = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: scenario.active.id },
      select: { status: true, autoClosed: true, closedAt: true },
    });
    expect(terminal.status).toBe(LiveSessionStatus.CLOSED);
    expect(terminal.autoClosed).toBe(true);
    expect(terminal.closedAt?.getTime()).toBe(controlledNow.getTime());

    const closedQuestion =
      await prisma.prisma.sessionQuestion.findUniqueOrThrow({
        where: { id: scenario.questionId },
        select: { status: true, closedAt: true },
      });
    expect(closedQuestion.status).toBe(SessionQuestionStatus.CLOSED);
    expect(closedQuestion.closedAt?.getTime()).toBe(controlledNow.getTime());
  });

  it('BE-6.4: a retry sweep is idempotent — no duplicate close, stable closedAt', async () => {
    requireDatabase();
    const scenario = await createBackdatedActiveSession(9 * 60 * 60 * 1000);
    const firstNow = new Date(BASE_NOW_MS);
    const retryNow = new Date(BASE_NOW_MS + 60_000); // next tick

    expect(await sessions.autoCloseExpiredSessions(firstNow)).toBe(1);
    const firstClose = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: scenario.active.id },
      select: { status: true, autoClosed: true, closedAt: true },
    });

    // Same candidate set, immediately re-run as the scheduler's next tick.
    expect(await sessions.autoCloseExpiredSessions(retryNow)).toBe(0);

    const afterRetry = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: scenario.active.id },
      select: { status: true, autoClosed: true, closedAt: true },
    });
    expect(afterRetry.status).toBe(LiveSessionStatus.CLOSED);
    expect(afterRetry.autoClosed).toBe(true);
    // stable conflict — closedAt is NOT rewritten on the retry.
    expect(afterRetry.closedAt?.getTime()).toBe(firstClose.closedAt?.getTime());

    // Archive follow-up is not duplicated by the retry.
    const archiveCount = await prisma.prisma.archivedResult.count({
      where: { liveSessionId: scenario.active.id },
    });
    expect(archiveCount).toBe(1);
    // No second SESSION_CLOSED outbox/event row for the same session.
    const eventCount = await prisma.prisma.liveSessionEvent.count({
      where: { liveSessionId: scenario.active.id, eventName: 'session.closed' },
    });
    expect(eventCount).toBe(1);
  });

  it('BE-6.6: a restart rescan over an already-closed session has no duplicate close side effects', async () => {
    requireDatabase();
    const scenario = await createBackdatedActiveSession(9 * 60 * 60 * 1000);
    const firstNow = new Date(BASE_NOW_MS);

    expect(await sessions.autoCloseExpiredSessions(firstNow)).toBe(1);
    const beforeRestart = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: scenario.active.id },
      select: { closedAt: true, autoClosed: true },
    });

    // Simulate a process restart: a fresh sweep later re-scans the same rows.
    const afterRestartNow = new Date(BASE_NOW_MS + 2 * 60_000);
    expect(await sessions.autoCloseExpiredSessions(afterRestartNow)).toBe(0);

    const afterRestart = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: scenario.active.id },
      select: { closedAt: true, autoClosed: true, status: true },
    });
    expect(afterRestart.status).toBe(LiveSessionStatus.CLOSED);
    expect(afterRestart.autoClosed).toBe(true);
    expect(afterRestart.closedAt?.getTime()).toBe(
      beforeRestart.closedAt?.getTime(),
    );

    const archiveCount = await prisma.prisma.archivedResult.count({
      where: { liveSessionId: scenario.active.id },
    });
    expect(archiveCount).toBe(1);
    const closeEventCount = await prisma.prisma.liveSessionEvent.count({
      where: { liveSessionId: scenario.active.id, eventName: 'session.closed' },
    });
    expect(closeEventCount).toBe(1);
  });

  it('does not auto-close a session that is not yet 8h old', async () => {
    requireDatabase();
    // 1h old — well under the hard limit; must not match the sweep.
    const scenario = await createBackdatedActiveSession(60 * 60 * 1000);
    const controlledNow = new Date(BASE_NOW_MS);

    expect(await sessions.autoCloseExpiredSessions(controlledNow)).toBe(0);

    const terminal = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: scenario.active.id },
      select: { status: true, autoClosed: true, closedAt: true },
    });
    expect(terminal.status).toBe(LiveSessionStatus.ACTIVE);
    expect(terminal.autoClosed).toBe(false);
    expect(terminal.closedAt).toBeNull();
  });
});
