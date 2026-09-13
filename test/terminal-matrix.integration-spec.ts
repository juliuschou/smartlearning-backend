import type { INestApplication } from '@nestjs/common';
import { newId } from '../src/common/crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  QuestionService,
  type QuestionWithOptions,
} from '../src/modules/questions/application/question.service';
import { LiveSessionService } from '../src/modules/live-sessions/application/live-session.service';
import { ParticipantService } from '../src/modules/participants/application/participant.service';
import { SubmissionService } from '../src/modules/submissions/application/submission.service';
import type { CreateQuestionDto } from '../src/modules/questions/api/dto';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';
import { LiveSessionStatus } from '../src/modules/live-sessions/domain/live-session-status';

/**
 * BE-3.1.8 CP8 transition-matrix evidence.
 *
 * Fills the previously-unasserted cells of the 28-state matrix. The state rules
 * are already frozen at the domain layer (live-session-status.spec.ts); this
 * suite proves the DB-backed service rejects each illegal terminal/state
 * transition with no row side effects, and that `waiting × join` is a
 * legitimate positive path (WAITING is joinable).
 *
 * Rows are created at startSession and cancel is only allowed from WAITING, so
 * a start/cancel session has no question rows to target; those open/submit
 * cells reject via NOT_FOUND / Unauthorized rather than the session-state 409.
 */
describe('LiveSession terminal-state matrix (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let questions: QuestionService;
  let sessions: LiveSessionService;
  let participants: ParticipantService;
  let submissions: SubmissionService;
  let dbReachable = false;
  let migrationsReady = false;

  const caller = {
    id: '0190c6b8-0000-7000-8000-000000000301',
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
    participants = app.get(ParticipantService);
    submissions = app.get(SubmissionService);
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
        'BLOCKED: PostgreSQL migration/schema is unavailable for terminal-matrix integration tests.',
      );
    }
  }

  async function createCourseAndQuestion(): Promise<{
    courseId: string;
    question: QuestionWithOptions;
  }> {
    const account = await prisma.prisma.account.create({
      data: {
        id: caller.id,
        username: `matrix-teacher-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        displayName: 'Matrix Teacher',
        role: caller.role,
        canCreateCourse: true,
      },
    });
    const course = await prisma.prisma.course.create({
      data: {
        id: newId(),
        ownerAccountId: account.id,
        name: 'Matrix Course',
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
    const question = await questions.createQuestion(course.id, caller, dto);
    return { courseId: course.id, question };
  }

  /** Create a session and advance it to the requested terminal state. */
  async function sessionInState(
    state: 'closed' | 'cancelled',
  ): Promise<{ liveSessionId: string; sessionQuestionId: string | null }> {
    const { courseId, question } = await createCourseAndQuestion();
    const waiting = await sessions.createSession(
      { courseId, questionIds: [question.id] },
      caller,
    );
    if (state === 'cancelled') {
      await sessions.cancelSession(waiting.id, caller);
      return { liveSessionId: waiting.id, sessionQuestionId: null };
    }
    const active = await sessions.startSession(waiting.id, caller);
    const sessionQuestionId = active.questions[0].id;
    // Open the question so the session close cascades it to `closed`; this
    // makes the `closed × open` cell prove a once-closed question cannot reopen.
    await sessions.openQuestion(active.id, sessionQuestionId, caller);
    await sessions.closeSession(active.id, caller);
    return { liveSessionId: active.id, sessionQuestionId };
  }

  it('rejects starting a closed session (closed × start)', async () => {
    requireDatabase();
    const { liveSessionId } = await sessionInState('closed');
    await expect(
      sessions.startSession(liveSessionId, caller),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const persisted = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: liveSessionId },
      select: { status: true },
    });
    expect(persisted.status).toBe(LiveSessionStatus.CLOSED);
  });

  it('rejects starting a cancelled session (cancelled × start)', async () => {
    requireDatabase();
    const { liveSessionId } = await sessionInState('cancelled');
    await expect(
      sessions.startSession(liveSessionId, caller),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const persisted = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: liveSessionId },
      select: { status: true },
    });
    expect(persisted.status).toBe(LiveSessionStatus.CANCELLED);
  });

  it('rejects opening a question on a closed session with its question row intact (closed × open)', async () => {
    requireDatabase();
    const { liveSessionId, sessionQuestionId } = await sessionInState('closed');
    expect(sessionQuestionId).not.toBeNull();
    await expect(
      sessions.openQuestion(liveSessionId, sessionQuestionId as string, caller),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // No question state mutation on the rejected open.
    const question = await prisma.prisma.sessionQuestion.findUniqueOrThrow({
      where: { id: sessionQuestionId as string },
      select: { status: true },
    });
    expect(question.status).toBe('closed');
  });

  it('rejects opening a question on a waiting session (waiting × open)', async () => {
    requireDatabase();
    const { courseId, question } = await createCourseAndQuestion();
    const waiting = await sessions.createSession(
      { courseId, questionIds: [question.id] },
      caller,
    );
    // Session created but not started ⇒ no session_question rows exist yet; a
    // question-open attempt is a NOT_FOUND reject (nothing to target) with no
    // side effects.
    await expect(
      sessions.openQuestion(waiting.id, question.id, caller),
    ).rejects.toBeInstanceOf(Error);
    const after = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: waiting.id },
      select: { status: true },
    });
    expect(after.status).toBe(LiveSessionStatus.WAITING);
  });

  it('rejects opening a question on a cancelled session (cancelled × open)', async () => {
    requireDatabase();
    const { courseId, question } = await createCourseAndQuestion();
    const waiting = await sessions.createSession(
      { courseId, questionIds: [question.id] },
      caller,
    );
    await sessions.cancelSession(waiting.id, caller);
    await expect(
      sessions.openQuestion(waiting.id, question.id, caller),
    ).rejects.toBeInstanceOf(Error);
    const after = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: waiting.id },
      select: { status: true },
    });
    expect(after.status).toBe(LiveSessionStatus.CANCELLED);
  });

  it('rejects submitting to a cancelled session without a submission row (cancelled × submit)', async () => {
    requireDatabase();
    const { courseId, question } = await createCourseAndQuestion();
    const waiting = await sessions.createSession(
      { courseId, questionIds: [question.id] },
      caller,
    );
    await sessions.cancelSession(waiting.id, caller);

    // A participant cannot legitimately be attached (join is rejected in
    // closed/cancelled terminal states); pass an explicit token that was never
    // issued so the submit rejects without any row side effects.
    await expect(
      submissions.submit(
        waiting.id,
        {
          participantId: newId(),
          liveSessionId: waiting.id,
        },
        newId(),
        { sessionQuestionId: question.id, selectedOptionRefs: ['source'] },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: waiting.id },
      }),
    ).toBe(0);
  });

  it('rejects submitting to a waiting session without a submission row (waiting × submit)', async () => {
    requireDatabase();
    const { courseId, question } = await createCourseAndQuestion();
    const waiting = await sessions.createSession(
      { courseId, questionIds: [question.id] },
      caller,
    );
    await expect(
      submissions.submit(
        waiting.id,
        { participantId: newId(), liveSessionId: waiting.id },
        newId(),
        { sessionQuestionId: question.id, selectedOptionRefs: ['source'] },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: waiting.id },
      }),
    ).toBe(0);
  });

  it('allows joining a waiting session (waiting × join/reconnect, positive)', async () => {
    requireDatabase();
    const { courseId, question } = await createCourseAndQuestion();
    const waiting = await sessions.createSession(
      { courseId, questionIds: [question.id] },
      caller,
    );
    const joined = await participants.join(
      waiting.sessionCode,
      'Waiting joiner',
    );
    expect(joined.participant.liveSessionId).toBe(waiting.id);
    const after = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: waiting.id },
      select: { status: true },
    });
    expect(after.status).toBe(LiveSessionStatus.WAITING);
    expect(
      await prisma.prisma.participant.count({
        where: { liveSessionId: waiting.id },
      }),
    ).toBe(1);
  });
});
