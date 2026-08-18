import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { newId, normalizeUuid } from '../../../common/crypto';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
} from '../../../common/errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import { QuestionService } from '../../questions/application/question.service';
import { AccountRole, isTeacherOrAdmin } from '../../identity/domain/roles';
import { AccountStatus } from '../../identity/domain/account-status';
import { EnrollmentStatus } from '../../enrollments/domain';
import { CourseStatus } from '../../courses/domain/course-status';
import { LiveSessionEventBus } from '../../realtime/live-session-event-bus';
import {
  aggregateResults,
  canCancelLiveSession,
  canCloseLiveSession,
  canCloseSessionQuestion,
  canOpenSessionQuestion,
  canStartLiveSession,
  generateSessionCode,
  isJoinableLiveSessionStatus,
  isSessionCode,
  LiveSessionStatus,
  normalizeSessionCode,
  SessionQuestionStatus,
} from '../domain';
import type {
  CreateLiveSessionDto,
  SessionQuestionResultsDto,
} from '../api/dto';

const sessionForProjection = {
  course: true,
  questionSelections: { orderBy: { position: 'asc' as const } },
  questions: {
    orderBy: { position: 'asc' as const },
    include: { options: { orderBy: { position: 'asc' as const } } },
  },
} as const;

type SessionProjection = Prisma.LiveSessionGetPayload<{
  include: typeof sessionForProjection;
}>;

export interface SessionQuestionProjection {
  id: string;
  liveSessionId: string;
  questionDefinitionId: string | null;
  position: number;
  status: string;
  snapshotType: string;
  snapshotPrompt: string;
  snapshotSelectionMode: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
  options: Array<{
    id: string;
    optionRef: string | null;
    text: string;
    position: number;
  }>;
}

@Injectable()
export class LiveSessionService {
  private readonly logger = new Logger(LiveSessionService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly transactions: TransactionService,
    private readonly questions: QuestionService,
    private readonly eventBus: LiveSessionEventBus,
  ) {}

  private get db() {
    return this.prismaService.prisma;
  }

  /**
   * Fire-and-forget realtime signal publish. Called only AFTER the mutation
   * transaction has committed (design §1: commit then publish). A publish
   * failure is logged and swallowed so it can never fail the domain mutation.
   */
  private publish(signal: Parameters<LiveSessionEventBus['publish']>[0]): void {
    void this.eventBus.publish(signal).catch((error) => {
      this.logger.error(
        {
          signalType: signal.type,
          liveSessionId: signal.liveSessionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Realtime publish failed; mutation already committed',
      );
    });
  }

  async createSession(
    dto: CreateLiveSessionDto,
    caller: { id: string; role: string },
  ): Promise<SessionProjection> {
    const courseId = normalizeUuid(dto.courseId);
    const questionIds = dto.questionIds.map(normalizeUuid);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const sessionCode = generateSessionCode();
      try {
        return await this.transactions.run(async (tx) => {
          await this.transactions.lockCourseForUpdate(tx, courseId);
          const course = await tx.course.findUnique({
            where: { id: courseId },
          });
          this.assertCourseAccess(course, caller);
          if (course.status !== CourseStatus.DRAFT) {
            throw new DomainError(
              'COURSE_NOT_EDITABLE',
              'Archived courses cannot start a LiveSession.',
              409,
              'courseId',
            );
          }

          const existing = await tx.liveSession.findFirst({
            where: {
              courseId,
              status: {
                in: [LiveSessionStatus.WAITING, LiveSessionStatus.ACTIVE],
              },
            },
          });
          if (existing) {
            throw new ConflictError(
              'Course already has a waiting or active LiveSession.',
              'courseId',
            );
          }

          const sourceQuestions = await this.questions.findForActivation(
            tx,
            courseId,
            questionIds,
          );
          const liveSession = await tx.liveSession.create({
            data: {
              id: newId(),
              courseId,
              status: LiveSessionStatus.WAITING,
              sessionCode,
            },
          });
          await tx.liveSessionQuestionSelection.createMany({
            data: sourceQuestions.map((question, index) => ({
              id: newId(),
              liveSessionId: liveSession.id,
              questionDefinitionId: question.id,
              courseId,
              position: index + 1,
            })),
          });
          return tx.liveSession.findUniqueOrThrow({
            where: { id: liveSession.id },
            include: sessionForProjection,
          });
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          attempt < 4
        ) {
          continue;
        }
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictError(
            'Could not allocate a unique LiveSession code.',
          );
        }
        throw error;
      }
    }
    throw new ConflictError('Could not allocate a unique LiveSession code.');
  }

  async startSession(
    sessionId: string,
    caller: { id: string; role: string },
  ): Promise<SessionProjection> {
    const canonicalSessionId = normalizeUuid(sessionId);
    const session = await this.transactions.run(
      async (tx) => {
        await this.transactions.lockLiveSessionForUpdate(
          tx,
          canonicalSessionId,
        );
        const session = await tx.liveSession.findUnique({
          where: { id: canonicalSessionId },
          include: {
            course: true,
            questionSelections: {
              orderBy: { position: 'asc' },
            },
          },
        });
        if (!session)
          throw new NotFoundError('LiveSession not found', 'liveSessionId');
        await this.transactions.lockCourseForUpdate(tx, session.courseId);
        const course = await tx.course.findUnique({
          where: { id: session.courseId },
        });
        this.assertCourseAccess(course, caller);
        if (course.status !== CourseStatus.DRAFT) {
          throw new DomainError(
            'COURSE_NOT_EDITABLE',
            'Archived courses cannot start a LiveSession.',
            409,
            'courseId',
          );
        }
        if (!canStartLiveSession(session.status as LiveSessionStatus)) {
          throw new ConflictError(
            'LiveSession cannot be started from its current state.',
            'status',
          );
        }
        if (session.questionSelections.length === 0) {
          throw new ConflictError(
            'LiveSession must contain at least one question.',
            'questionIds',
          );
        }

        const sourceQuestions = await this.questions.findForActivation(
          tx,
          session.courseId,
          session.questionSelections.map(
            (selection) => selection.questionDefinitionId,
          ),
        );

        for (const [index, source] of sourceQuestions.entries()) {
          const selection = session.questionSelections[index];
          await tx.sessionQuestion.create({
            data: {
              id: newId(),
              liveSessionId: session.id,
              questionDefinitionId: source.id,
              position: selection.position,
              status: SessionQuestionStatus.NOT_OPEN,
              snapshotType: source.type,
              snapshotPrompt: source.prompt,
              snapshotSelectionMode: source.selectionMode,
              options: {
                create: source.options.map((option) => ({
                  id: newId(),
                  optionRef: option.optionRef,
                  text: option.text,
                  isCorrect: option.isCorrect,
                  position: option.position,
                })),
              },
            },
          });
        }

        await tx.liveSession.update({
          where: { id: session.id },
          data: { status: LiveSessionStatus.ACTIVE, startedAt: new Date() },
        });
        return tx.liveSession.findUniqueOrThrow({
          where: { id: session.id },
          include: sessionForProjection,
        });
      },
      { timeout: 30_000 },
    );
    this.publish({
      type: 'session.state_changed',
      liveSessionId: canonicalSessionId,
      status: LiveSessionStatus.ACTIVE,
    });
    return session;
  }

  async openQuestion(
    sessionId: string,
    sessionQuestionId: string,
    caller: { id: string; role: string },
  ): Promise<SessionQuestionProjection> {
    return this.transitionQuestion(
      sessionId,
      sessionQuestionId,
      caller,
      'open',
    );
  }

  async closeSession(
    sessionId: string,
    caller: { id: string; role: string },
  ): Promise<SessionProjection> {
    const canonicalSessionId = normalizeUuid(sessionId);
    const { session, closedQuestionIds } = await this.transactions.run(
      async (tx) => {
        await this.transactions.lockLiveSessionForUpdate(
          tx,
          canonicalSessionId,
        );
        const session = await tx.liveSession.findUnique({
          where: { id: canonicalSessionId },
          include: {
            course: true,
            questions: { where: { status: SessionQuestionStatus.OPEN } },
          },
        });
        if (!session)
          throw new NotFoundError('LiveSession not found', 'liveSessionId');
        this.assertCourseAccess(session.course, caller);
        if (!canCloseLiveSession(session.status as LiveSessionStatus)) {
          throw new ConflictError(
            'LiveSession cannot be closed from its current state.',
            'status',
          );
        }

        const closedAt = new Date();
        // Close the currently open SessionQuestion(s) under the same transaction.
        // The session row is already FOR UPDATE; the commit of this transaction is
        // the linearization point shared with the question-close path (design §5.2).
        const closedQuestionIds = session.questions.map((q) => q.id);
        await tx.sessionQuestion.updateMany({
          where: {
            liveSessionId: session.id,
            status: SessionQuestionStatus.OPEN,
          },
          data: { status: SessionQuestionStatus.CLOSED, closedAt },
        });
        await tx.liveSession.update({
          where: { id: session.id },
          data: {
            status: LiveSessionStatus.CLOSED,
            closedAt,
            autoClosed: false,
          },
        });
        return {
          session: await tx.liveSession.findUniqueOrThrow({
            where: { id: session.id },
            include: sessionForProjection,
          }),
          closedQuestionIds,
        };
      },
    );
    // Publish after commit. Bulk-close emits a question.closed signal per
    // previously-open question (at most one by invariant) plus the state change.
    for (const qid of closedQuestionIds) {
      this.publish({
        type: 'question.closed',
        liveSessionId: canonicalSessionId,
        sessionQuestionId: qid,
      });
    }
    this.publish({
      type: 'session.state_changed',
      liveSessionId: canonicalSessionId,
      status: LiveSessionStatus.CLOSED,
    });
    return session;
  }

  async cancelSession(
    sessionId: string,
    caller: { id: string; role: string },
  ): Promise<SessionProjection> {
    const canonicalSessionId = normalizeUuid(sessionId);
    const session = await this.transactions.run(async (tx) => {
      await this.transactions.lockLiveSessionForUpdate(tx, canonicalSessionId);
      const session = await tx.liveSession.findUnique({
        where: { id: canonicalSessionId },
        include: { course: true },
      });
      if (!session)
        throw new NotFoundError('LiveSession not found', 'liveSessionId');
      this.assertCourseAccess(session.course, caller);
      if (!canCancelLiveSession(session.status as LiveSessionStatus)) {
        throw new ConflictError(
          'LiveSession cannot be cancelled from its current state.',
          'status',
        );
      }
      // Cancel is the discard path: no ArchivedResult, no closedAt (design §6.1).
      // Existing SessionQuestion/Submission rows are retained for later retention.
      await tx.liveSession.update({
        where: { id: session.id },
        data: { status: LiveSessionStatus.CANCELLED },
      });
      return tx.liveSession.findUniqueOrThrow({
        where: { id: session.id },
        include: sessionForProjection,
      });
    });
    this.publish({
      type: 'session.state_changed',
      liveSessionId: canonicalSessionId,
      status: LiveSessionStatus.CANCELLED,
    });
    return session;
  }

  async closeQuestion(
    sessionId: string,
    sessionQuestionId: string,
    caller: { id: string; role: string },
  ): Promise<SessionQuestionProjection> {
    return this.transitionQuestion(
      sessionId,
      sessionQuestionId,
      caller,
      'closed',
    );
  }

  async findByCode(sessionCode: string): Promise<SessionProjection> {
    const normalized = normalizeSessionCode(sessionCode);
    if (!isSessionCode(normalized)) {
      throw new DomainError(
        'SESSION_NOT_JOINABLE',
        'LiveSession cannot be joined.',
        409,
        'sessionCode',
      );
    }
    const session = await this.db.liveSession.findUnique({
      where: { sessionCode: normalized },
      include: sessionForProjection,
    });
    if (!session || !isJoinableLiveSessionStatus(session.status)) {
      throw new DomainError(
        'SESSION_NOT_JOINABLE',
        'LiveSession cannot be joined.',
        409,
      );
    }
    return session;
  }

  async getSnapshot(
    sessionId: string,
    caller?: { id: string; role: string },
  ): Promise<SessionProjection> {
    const canonicalSessionId = normalizeUuid(sessionId);
    const session = await this.db.liveSession.findUnique({
      where: { id: canonicalSessionId },
      include: sessionForProjection,
    });
    if (!session)
      throw new NotFoundError('LiveSession not found', 'liveSessionId');
    if (caller) this.assertCourseAccess(session.course, caller);
    return session;
  }

  /**
   * Teacher session detail (S-2): full projection plus live joined/voted
   * counts. `joined` = Participant rows for the session; `voted` = Submission
   * rows for the currently open SessionQuestion (0 when no question is open).
   * Owner/admin check runs before counts so a non-owner gets 404 (no existence
   * leak), matching S-1/S-3 ordering. Counts are derived on-the-fly from
   * committed rows — no Aggregate/VoteCount authority (design §5.2 / S-3).
   */
  async getTeacherDetail(
    sessionId: string,
    caller: { id: string; role: string },
  ): Promise<{
    session: SessionProjection;
    joinedCount: number;
    votedCount: number;
  }> {
    const canonicalSessionId = normalizeUuid(sessionId);
    const session = await this.db.liveSession.findUnique({
      where: { id: canonicalSessionId },
      include: sessionForProjection,
    });
    if (!session)
      throw new NotFoundError('LiveSession not found', 'liveSessionId');
    this.assertCourseAccess(session.course, caller);

    // At most one SessionQuestion may be open at a time (P2002 guard in
    // transitionQuestion), so find() yields the single current question or null.
    const current =
      session.questions.find(
        (question) => question.status === SessionQuestionStatus.OPEN,
      ) ?? null;

    const [joinedCount, votedCount] = await Promise.all([
      this.db.participant.count({
        where: { liveSessionId: canonicalSessionId },
      }),
      current
        ? this.db.submission.count({
            where: {
              liveSessionId: canonicalSessionId,
              sessionQuestionId: current.id,
            },
          })
        : Promise.resolve(0),
    ]);

    return { session, joinedCount, votedCount };
  }

  async getParticipantSnapshot(
    sessionId: string,
    participantId: string,
    accountId?: string,
  ): Promise<{
    session: SessionProjection;
    submittedQuestionIds: Set<string>;
  }> {
    const canonicalSessionId = normalizeUuid(sessionId);
    const canonicalParticipantId = normalizeUuid(participantId);
    return this.transactions.run(
      async (tx) => {
        const participant = await tx.participant.findUnique({
          where: { id: canonicalParticipantId },
          select: { liveSessionId: true, accountId: true },
        });
        if (!participant || participant.liveSessionId !== canonicalSessionId) {
          throw new NotFoundError('Participant not found', 'participantId');
        }
        const session = await tx.liveSession.findUnique({
          where: { id: canonicalSessionId },
          include: sessionForProjection,
        });
        if (!session)
          throw new NotFoundError('LiveSession not found', 'liveSessionId');
        if (!isJoinableLiveSessionStatus(session.status)) {
          throw new DomainError(
            'SESSION_NOT_JOINABLE',
            'LiveSession cannot be joined.',
            409,
          );
        }
        if (accountId !== undefined) {
          const canonicalAccountId = normalizeUuid(accountId);
          if (
            participant.accountId === null ||
            normalizeUuid(participant.accountId) !== canonicalAccountId
          ) {
            throw new ForbiddenError('Active student participant required');
          }
          const account = await tx.account.findUnique({
            where: { id: canonicalAccountId },
            select: { role: true, status: true },
          });
          const enrollment = await tx.courseEnrollment.findUnique({
            where: {
              courseId_studentAccountId: {
                courseId: session.courseId,
                studentAccountId: canonicalAccountId,
              },
            },
            select: { status: true },
          });
          if (
            !account ||
            account.role !== AccountRole.STUDENT ||
            account.status !== AccountStatus.ACTIVE ||
            enrollment?.status !== EnrollmentStatus.ACTIVE
          ) {
            throw new ForbiddenError('Active course enrollment required');
          }
        }
        const submissions = await tx.submission.findMany({
          where: {
            liveSessionId: canonicalSessionId,
            participantId: canonicalParticipantId,
          },
          select: { sessionQuestionId: true },
        });
        return {
          session,
          submittedQuestionIds: new Set(
            submissions.map((submission) => submission.sessionQuestionId),
          ),
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );
  }

  /**
   * Results projection for a single SessionQuestion (S-3).
   *
   * Aggregation is derived on-the-fly from committed Submission rows — no
   * Aggregate/VoteCount authority. Teacher (owner/admin) sees the anonymous
   * aggregate at any time; participant sees it only after they have submitted
   * (while the question is open) or after the question is closed (vote-to-reveal,
   * US-F17). `isCorrect` for quiz is revealed to participants only when the
   * question is closed.
   */
  async getResults(
    liveSessionId: string,
    sessionQuestionId: string,
    actor:
      | { kind: 'teacher'; accountId: string; role: string }
      | { kind: 'participant'; participantId: string; accountId?: string },
  ): Promise<SessionQuestionResultsDto> {
    const canonicalSessionId = normalizeUuid(liveSessionId);
    const canonicalQuestionId = normalizeUuid(sessionQuestionId);

    const question = await this.db.sessionQuestion.findUnique({
      where: {
        id_liveSessionId: {
          id: canonicalQuestionId,
          liveSessionId: canonicalSessionId,
        },
      },
      include: {
        liveSession: { include: { course: true } },
        options: { orderBy: { position: 'asc' } },
        submissions: {
          select: {
            selectedOptionRefs: true,
            textAnswer: true,
            participantId: true,
          },
        },
      },
    });
    if (!question) {
      throw new NotFoundError('SessionQuestion not found', 'sessionQuestionId');
    }

    let revealCorrectness: boolean;
    let canonicalParticipantId: string | undefined;
    if (actor.kind === 'teacher') {
      // Owner/admin check via the loaded course; non-owner → 404 (no existence
      // leak). This runs before the status check so a non-owner cannot learn
      // that a question exists via a state-specific 409.
      this.assertCourseAccess(question.liveSession.course, {
        id: actor.accountId,
        role: actor.role,
      });
      revealCorrectness = true;
    } else {
      canonicalParticipantId = normalizeUuid(actor.participantId);
      // Defense in depth: confirm the participant belongs to this session.
      // (The guard already bound the token to the session via hash lookup.)
      const participant = await this.db.participant.findUnique({
        where: { id: canonicalParticipantId },
        select: { liveSessionId: true, accountId: true },
      });
      if (!participant || participant.liveSessionId !== canonicalSessionId) {
        throw new NotFoundError('Participant not found', 'participantId');
      }
      if (actor.accountId !== undefined) {
        const canonicalAccountId = normalizeUuid(actor.accountId);
        if (
          participant.accountId === null ||
          normalizeUuid(participant.accountId) !== canonicalAccountId
        ) {
          throw new ForbiddenError('Active student participant required');
        }
        const account = await this.db.account.findUnique({
          where: { id: canonicalAccountId },
          select: { role: true, status: true },
        });
        const enrollment = await this.db.courseEnrollment.findUnique({
          where: {
            courseId_studentAccountId: {
              courseId: question.liveSession.courseId,
              studentAccountId: canonicalAccountId,
            },
          },
          select: { status: true },
        });
        if (
          !account ||
          account.role !== AccountRole.STUDENT ||
          account.status !== AccountStatus.ACTIVE ||
          enrollment?.status !== EnrollmentStatus.ACTIVE
        ) {
          throw new ForbiddenError('Active course enrollment required');
        }
      }
      // Participants see correct answers only after the question is closed.
      revealCorrectness = question.status === SessionQuestionStatus.CLOSED;
    }

    if (question.status === SessionQuestionStatus.NOT_OPEN) {
      throw new DomainError(
        'SESSION_QUESTION_NOT_OPEN',
        'Results are not available for a question that has not been opened.',
        409,
        'sessionQuestionId',
      );
    }

    if (canonicalParticipantId !== undefined) {
      const hasSubmitted = question.submissions.some(
        (submission) => submission.participantId === canonicalParticipantId,
      );
      if (question.status === SessionQuestionStatus.OPEN && !hasSubmitted) {
        throw new DomainError(
          'RESULTS_NOT_REVEALED',
          'Submit your own answer before viewing live results for this question.',
          409,
          undefined,
          'Submit an answer to reveal the aggregate.',
        );
      }
    }

    return aggregateResults({
      snapshotType: question.snapshotType,
      selectionMode: question.snapshotSelectionMode,
      status: question.status,
      options: question.options.map((option) => ({
        id: option.id,
        optionRef: option.optionRef,
        text: option.text,
        isCorrect: option.isCorrect,
      })),
      submissions: question.submissions.map((submission) => ({
        selectedOptionRefs:
          (submission.selectedOptionRefs as string[] | null) ?? null,
        textAnswer: submission.textAnswer,
      })),
      revealCorrectness,
    });
  }

  private async transitionQuestion(
    sessionId: string,
    sessionQuestionId: string,
    caller: { id: string; role: string },
    target: 'open' | 'closed',
  ): Promise<SessionQuestionProjection> {
    const canonicalSessionId = normalizeUuid(sessionId);
    const canonicalQuestionId = normalizeUuid(sessionQuestionId);
    const updated = await this.transactions.run(async (tx) => {
      await this.transactions.lockSessionQuestionForUpdate(
        tx,
        canonicalQuestionId,
      );
      const question = await tx.sessionQuestion.findUnique({
        where: { id: canonicalQuestionId },
        include: {
          liveSession: { include: { course: true } },
          options: { orderBy: { position: 'asc' } },
        },
      });
      if (!question || question.liveSessionId !== canonicalSessionId) {
        throw new NotFoundError(
          'SessionQuestion not found',
          'sessionQuestionId',
        );
      }
      this.assertCourseAccess(question.liveSession.course, caller);
      if (question.liveSession.status !== LiveSessionStatus.ACTIVE) {
        throw new ConflictError('LiveSession is not active.', 'status');
      }

      const current = question.status as SessionQuestionStatus;
      const allowed =
        target === 'open'
          ? canOpenSessionQuestion(current)
          : canCloseSessionQuestion(current);
      if (!allowed) {
        throw new ConflictError(
          target === 'open'
            ? 'SessionQuestion cannot be opened from its current state.'
            : 'SessionQuestion cannot be closed from its current state.',
          'status',
        );
      }

      try {
        const updated = await tx.sessionQuestion.update({
          where: { id: question.id },
          data:
            target === 'open'
              ? { status: SessionQuestionStatus.OPEN, openedAt: new Date() }
              : { status: SessionQuestionStatus.CLOSED, closedAt: new Date() },
          include: { options: { orderBy: { position: 'asc' } } },
        });
        return updated;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictError(
            'Only one SessionQuestion may be open at a time.',
            'status',
          );
        }
        throw error;
      }
    });
    // Publish after commit. The transition target maps 1:1 to a signal type.
    this.publish({
      type: target === 'open' ? 'question.opened' : 'question.closed',
      liveSessionId: canonicalSessionId,
      sessionQuestionId: updated.id,
    });
    return updated;
  }

  private assertCourseAccess(
    course: { ownerAccountId: string } | null,
    caller: { id: string; role: string },
  ): asserts course is { ownerAccountId: string } {
    if (!isTeacherOrAdmin(caller.role)) {
      throw new ForbiddenError('Teacher or admin role required');
    }
    if (
      !course ||
      (course.ownerAccountId !== caller.id && caller.role !== 'admin')
    ) {
      throw new NotFoundError('Course not found', 'courseId');
    }
  }
}

export function toSessionQuestionDto(question: SessionQuestionProjection) {
  return {
    id: question.id,
    liveSessionId: question.liveSessionId,
    questionDefinitionId: question.questionDefinitionId,
    position: question.position,
    status: question.status,
    snapshotType: question.snapshotType,
    snapshotPrompt: question.snapshotPrompt,
    snapshotSelectionMode: question.snapshotSelectionMode,
    openedAt: question.openedAt?.toISOString() ?? null,
    closedAt: question.closedAt?.toISOString() ?? null,
    options: question.options.map((option) => ({
      id: option.id,
      optionRef: option.optionRef,
      text: option.text,
      position: option.position,
    })),
  };
}

export function toLiveSessionDto(
  session: SessionProjection,
  counts?: { joinedCount: number; votedCount: number },
) {
  return {
    id: session.id,
    courseId: session.courseId,
    status: session.status,
    sessionCode: session.sessionCode,
    startedAt: session.startedAt?.toISOString() ?? null,
    closedAt: session.closedAt?.toISOString() ?? null,
    autoClosed: session.autoClosed,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    ...(counts ?? {}),
    questionSelections: session.questionSelections.map((selection) => ({
      questionDefinitionId: selection.questionDefinitionId,
      position: selection.position,
    })),
    sessionQuestions: session.questions.map((question) =>
      toSessionQuestionDto({
        id: question.id,
        liveSessionId: question.liveSessionId,
        questionDefinitionId: question.questionDefinitionId,
        position: question.position,
        status: question.status,
        snapshotType: question.snapshotType,
        snapshotPrompt: question.snapshotPrompt,
        snapshotSelectionMode: question.snapshotSelectionMode,
        openedAt: question.openedAt,
        closedAt: question.closedAt,
        options: question.options,
      }),
    ),
  };
}
