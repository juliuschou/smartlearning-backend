import type { INestApplication } from '@nestjs/common';
import { DomainError } from '../src/common/errors';
import { hashToken, newId } from '../src/common/crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  QuestionService,
  type QuestionWithOptions,
} from '../src/modules/questions/application/question.service';
import { LiveSessionService } from '../src/modules/live-sessions/application/live-session.service';
import { ParticipantService } from '../src/modules/participants/application/participant.service';
import { SubmissionService } from '../src/modules/submissions/application/submission.service';
import type { CreateQuestionDto } from '../src/modules/questions/api/dto';
import type { CreateSubmissionDto } from '../src/modules/submissions/api/dto';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('Poll submission (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let questions: QuestionService;
  let sessions: LiveSessionService;
  let participants: ParticipantService;
  let submissions: SubmissionService;
  let dbReachable = false;
  let migrationsReady = false;

  const caller = {
    id: '0190c6b8-0000-7000-8000-000000000101',
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
    if (dbReachable)
      await withQuiescedLiveSessionPublisher(app, () =>
        truncateAll(prisma.prisma),
      );
  });

  async function createScenario(questionCount = 1) {
    const account = await prisma.prisma.account.create({
      data: {
        id: caller.id,
        username: `poll-teacher-${newId().slice(-8)}`,
        displayName: 'Poll Teacher',
        role: caller.role,
        canCreateCourse: true,
      },
    });
    const course = await prisma.prisma.course.create({
      data: {
        id: newId(),
        ownerAccountId: account.id,
        name: 'Poll Course',
        status: 'draft',
      },
    });

    const sourceQuestions: QuestionWithOptions[] = [];
    for (let index = 0; index < questionCount; index += 1) {
      const dto: CreateQuestionDto = {
        type: 'poll',
        prompt: `Which concept matters most? ${index + 1}`,
        selectionMode: 'single',
        options: [
          { optionRef: 'source', text: 'Source data' },
          { optionRef: 'bias', text: 'Sample bias' },
          { optionRef: 'causality', text: 'Causality' },
        ],
      };
      sourceQuestions.push(
        await questions.createQuestion(course.id, caller, dto),
      );
    }

    const waiting = await sessions.createSession(
      {
        courseId: course.id,
        questionIds: sourceQuestions.map((question) => question.id),
      },
      caller,
    );
    const active = await sessions.startSession(waiting.id, caller);
    return { course, sourceQuestions, waiting, active };
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for poll integration tests.',
      );
    }
  }

  it('persists ordered selections and an immutable activation snapshot', async () => {
    requireDatabase();
    const scenario = await createScenario();
    expect(scenario.waiting.status).toBe('waiting');
    expect(scenario.waiting.questionSelections).toHaveLength(1);
    expect(scenario.active.status).toBe('active');
    expect(scenario.active.questions).toHaveLength(1);

    const activeQuestion = scenario.active.questions[0];
    expect(activeQuestion.options.map((option) => option.optionRef)).toEqual([
      'source',
      'bias',
      'causality',
    ]);
    const persistedSourceOptions = await prisma.prisma.questionOption.findMany({
      where: { questionDefinitionId: scenario.sourceQuestions[0].id },
      orderBy: { position: 'asc' },
      select: { optionRef: true },
    });
    expect(persistedSourceOptions.map((option) => option.optionRef)).toEqual([
      'source',
      'bias',
      'causality',
    ]);
    await prisma.prisma.questionDefinition.update({
      where: { id: scenario.sourceQuestions[0].id },
      data: { prompt: 'Changed after activation' },
    });

    const snapshot = await prisma.prisma.sessionQuestion.findUnique({
      where: { id: activeQuestion.id },
    });
    expect(snapshot?.snapshotPrompt).toBe('Which concept matters most? 1');
    expect(snapshot?.snapshotPrompt).not.toBe('Changed after activation');
    expect(activeQuestion.options.map((option) => option.position)).toEqual([
      1, 2, 3,
    ]);
  });

  it('rejects cross-course source selections at the database boundary', async () => {
    requireDatabase();
    const scenario = await createScenario();
    const otherCourse = await prisma.prisma.course.create({
      data: {
        id: newId(),
        ownerAccountId: caller.id,
        name: 'Other Poll Course',
        status: 'draft',
      },
    });
    const otherQuestion = await questions.createQuestion(
      otherCourse.id,
      caller,
      {
        type: 'poll',
        prompt: 'Which other concept matters most?',
        selectionMode: 'single',
        options: [
          { optionRef: 'source', text: 'Source data' },
          { optionRef: 'bias', text: 'Sample bias' },
        ],
      },
    );

    await expect(
      prisma.prisma.$executeRaw`
        INSERT INTO "live_session_question_selection"
          ("id", "live_session_id", "question_definition_id", "course_id", "position")
        VALUES (
          ${newId()}::uuid,
          ${scenario.waiting.id}::uuid,
          ${otherQuestion.id}::uuid,
          ${scenario.course.id}::uuid,
          99
        )
      `,
    ).rejects.toThrow();

    expect(
      await prisma.prisma.liveSessionQuestionSelection.count({
        where: {
          liveSessionId: scenario.waiting.id,
          questionDefinitionId: otherQuestion.id,
        },
      }),
    ).toBe(0);
  });

  it('enforces open-state, one-answer, replay, and immutable-answer semantics', async () => {
    requireDatabase();
    const scenario = await createScenario(2);
    const firstQuestion = scenario.active.questions[0];
    const secondQuestion = scenario.active.questions[1];
    await sessions.openQuestion(scenario.active.id, firstQuestion.id, caller);
    await expect(
      sessions.openQuestion(scenario.active.id, secondQuestion.id, caller),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const joined = await participants.join(
      scenario.waiting.sessionCode,
      ' 小明 ',
    );
    const participant = await participants.authenticate(
      scenario.active.id,
      joined.participantToken,
    );
    const selectedOptionRefs = [firstQuestion.options[0].id.toUpperCase()];
    const firstInput: CreateSubmissionDto = {
      sessionQuestionId: firstQuestion.id,
      selectedOptionRefs,
    };
    const idempotencyKey = newId();
    const first = await submissions.submit(
      scenario.active.id,
      participant,
      idempotencyKey,
      firstInput,
    );
    const replay = await submissions.submit(
      scenario.active.id,
      participant,
      idempotencyKey,
      firstInput,
    );
    expect(replay.id).toBe(first.id);
    const optionRefReplay = await submissions.submit(
      scenario.active.id,
      participant,
      idempotencyKey,
      {
        ...firstInput,
        selectedOptionRefs: [firstQuestion.options[0].optionRef as string],
      },
    );
    expect(optionRefReplay.id).toBe(first.id);

    await expect(
      submissions.submit(scenario.active.id, participant, idempotencyKey, {
        ...firstInput,
        selectedOptionRefs: [firstQuestion.options[1].optionRef as string],
      }),
    ).rejects.toMatchObject({ code: 'SUBMISSION_CONFLICT' });
    await expect(
      submissions.submit(scenario.active.id, participant, newId(), {
        ...firstInput,
        selectedOptionRefs: [firstQuestion.options[1].optionRef as string],
      }),
    ).rejects.toMatchObject({ code: 'SUBMISSION_CONFLICT' });

    await sessions.closeQuestion(scenario.active.id, firstQuestion.id, caller);
    const closedReplay = await submissions.submit(
      scenario.active.id,
      participant,
      idempotencyKey,
      firstInput,
    );
    expect(closedReplay.id).toBe(first.id);
    await expect(
      submissions.submit(scenario.active.id, participant, newId(), firstInput),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const storedParticipant = await prisma.prisma.participant.findUnique({
      where: { id: joined.participant.id },
    });
    expect(storedParticipant?.tokenHash).toBe(
      hashToken(joined.participantToken),
    );
    expect(storedParticipant?.tokenHash).not.toBe(joined.participantToken);
    expect(await prisma.prisma.submission.count()).toBe(1);
  });

  async function holdSessionRowLock(sessionId: string): Promise<{
    acquired: Promise<void>;
    release: () => void;
    done: Promise<void>;
  }> {
    let markAcquired!: () => void;
    let releaseLock!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const done = prisma.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM live_session WHERE id = ${sessionId}::uuid FOR UPDATE
      `;
      markAcquired();
      await released;
    });
    await acquired;
    return { acquired, release: releaseLock, done };
  }

  it('serializes concurrent submissions for one participant and question', async () => {
    requireDatabase();
    const scenario = await createScenario();
    const question = scenario.active.questions[0];
    await sessions.openQuestion(scenario.active.id, question.id, caller);
    const joined = await participants.join(
      scenario.waiting.sessionCode,
      'Concurrent participant',
    );
    const participant = await participants.authenticate(
      scenario.active.id,
      joined.participantToken,
    );
    const input: CreateSubmissionDto = {
      sessionQuestionId: question.id,
      selectedOptionRefs: [question.options[0].id],
    };

    const results = await Promise.allSettled([
      submissions.submit(scenario.active.id, participant, newId(), input),
      submissions.submit(scenario.active.id, participant, newId(), input),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
      DomainError,
    );
    expect(await prisma.prisma.submission.count()).toBe(1);
  });

  it('deterministically gives the queued close operation the session lock before cancel', async () => {
    requireDatabase();
    const scenario = await createScenario();
    const lock = await holdSessionRowLock(scenario.active.id);

    const closePromise = sessions.closeSession(scenario.active.id, caller);
    await Promise.resolve();
    const cancelPromise = sessions.cancelSession(scenario.active.id, caller);
    lock.release();

    const [close, cancel] = await Promise.allSettled([
      closePromise,
      cancelPromise,
    ]);
    await lock.done;
    expect(close.status).toBe('fulfilled');
    expect(cancel.status).toBe('rejected');
    expect(cancel.status === 'rejected' && cancel.reason).toMatchObject({
      code: 'CONFLICT',
    });

    const terminal = await prisma.prisma.liveSession.findUniqueOrThrow({
      where: { id: scenario.active.id },
      select: { status: true, closedAt: true },
    });
    expect(terminal.status).toBe('closed');
    expect(terminal.closedAt).not.toBeNull();
    await expect(
      sessions.closeSession(scenario.active.id, caller),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      (
        await prisma.prisma.liveSession.findUniqueOrThrow({
          where: { id: scenario.active.id },
          select: { closedAt: true },
        })
      ).closedAt,
    ).toEqual(terminal.closedAt);
  });

  it('deterministically gives the queued cancel operation the session lock before close', async () => {
    requireDatabase();
    await createScenario();
    const secondCourse = await prisma.prisma.course.create({
      data: {
        id: newId(),
        ownerAccountId: caller.id,
        name: 'Second Poll Course',
        status: 'draft',
      },
    });
    const secondQuestion = await questions.createQuestion(
      secondCourse.id,
      caller,
      {
        type: 'poll',
        prompt: 'Second question',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      },
    );
    const waiting = await sessions.createSession(
      { courseId: secondCourse.id, questionIds: [secondQuestion.id] },
      caller,
    );
    const lock = await holdSessionRowLock(waiting.id);

    const cancelPromise = sessions.cancelSession(waiting.id, caller);
    await Promise.resolve();
    const closePromise = sessions.closeSession(waiting.id, caller);
    lock.release();

    const [cancel, close] = await Promise.allSettled([
      cancelPromise,
      closePromise,
    ]);
    await lock.done;
    expect(cancel.status).toBe('fulfilled');
    expect(close.status).toBe('rejected');
    expect(close.status === 'rejected' && close.reason).toMatchObject({
      code: 'CONFLICT',
    });
    expect(
      await prisma.prisma.liveSession.findUniqueOrThrow({
        where: { id: waiting.id },
        select: { status: true, closedAt: true },
      }),
    ).toEqual({ status: 'cancelled', closedAt: null });
  });

  it('proves submit-first commit ordering before close', async () => {
    requireDatabase();
    const scenario = await createScenario();
    const question = scenario.active.questions[0];
    await sessions.openQuestion(scenario.active.id, question.id, caller);
    const joined = await participants.join(
      scenario.waiting.sessionCode,
      'Race participant',
    );
    const participant = await participants.authenticate(
      scenario.active.id,
      joined.participantToken,
    );
    const input: CreateSubmissionDto = {
      sessionQuestionId: question.id,
      selectedOptionRefs: [question.options[0].id],
    };
    // Hold the authority row so both real transactions queue on the same
    // PostgreSQL lock, then release them together. Submission and close must
    // share the live_session → session_question lock order.
    const lock = await holdSessionRowLock(scenario.active.id);
    const submitPromise = submissions.submit(
      scenario.active.id,
      participant,
      newId(),
      input,
    );
    await Promise.resolve();
    const closePromise = sessions.closeSession(scenario.active.id, caller);
    lock.release();

    const [submit, close] = await Promise.allSettled([
      submitPromise,
      closePromise,
    ]);
    await lock.done;
    expect(close.status).toBe('fulfilled');
    expect(close.status === 'fulfilled' && close.value.status).toBe('closed');
    const submissionCount = await prisma.prisma.submission.count({
      where: { liveSessionId: scenario.active.id },
    });
    expect(submissionCount).toBeLessThanOrEqual(1);
    if (submit.status === 'fulfilled') {
      expect(submit.value.id).toBeDefined();
      expect(submissionCount).toBe(1);
    } else {
      expect(submit.reason).toMatchObject({ code: 'CONFLICT' });
      expect(submissionCount).toBe(0);
    }
    expect(
      await prisma.prisma.sessionQuestion.findUniqueOrThrow({
        where: { id: question.id },
        select: { status: true },
      }),
    ).toEqual({ status: 'closed' });
  });

  it('proves close-first commit ordering before a blocked submission', async () => {
    requireDatabase();
    const scenario = await createScenario();
    const question = scenario.active.questions[0];
    await sessions.openQuestion(scenario.active.id, question.id, caller);
    const joined = await participants.join(
      scenario.waiting.sessionCode,
      'Close first',
    );
    const participant = await participants.authenticate(
      scenario.active.id,
      joined.participantToken,
    );
    const lock = await holdSessionRowLock(scenario.active.id);
    const closePromise = sessions.closeSession(scenario.active.id, caller);
    await Promise.resolve();
    const submitPromise = submissions.submit(
      scenario.active.id,
      participant,
      newId(),
      {
        sessionQuestionId: question.id,
        selectedOptionRefs: [question.options[0].id],
      },
    );
    lock.release();

    const [close, submit] = await Promise.allSettled([
      closePromise,
      submitPromise,
    ]);
    await lock.done;
    expect(close.status).toBe('fulfilled');
    expect(close.status === 'fulfilled' && close.value.status).toBe('closed');
    const submissionCount = await prisma.prisma.submission.count({
      where: { liveSessionId: scenario.active.id },
    });
    expect(submissionCount).toBeLessThanOrEqual(1);
    if (submit.status === 'rejected') {
      expect(submit.reason).toMatchObject({ code: 'CONFLICT' });
      expect(submissionCount).toBe(0);
    } else {
      expect(submit.value.id).toBeDefined();
      expect(submissionCount).toBe(1);
    }
  });
});
