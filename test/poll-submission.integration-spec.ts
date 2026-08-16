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
import { createTestApp } from './setup/app-factory';
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
    if (dbReachable) await truncateAll(prisma.prisma);
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
});
