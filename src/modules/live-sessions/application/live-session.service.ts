import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import { newId, normalizeUuid } from '../../../common/crypto';
import {
  ConflictError,
  DomainError,
  NotFoundError,
} from '../../../common/errors';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import { QuestionService } from '../../questions/application/question.service';
import { CourseStatus } from '../../courses/domain/course-status';
import {
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
import type { CreateLiveSessionDto } from '../api/dto';

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
  constructor(
    private readonly prismaService: PrismaService,
    private readonly transactions: TransactionService,
    private readonly questions: QuestionService,
  ) {}

  private get db() {
    return this.prismaService.prisma;
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
    return this.transactions.run(
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
    return this.transactions.run(async (tx) => {
      await this.transactions.lockLiveSessionForUpdate(tx, canonicalSessionId);
      const session = await tx.liveSession.findUnique({
        where: { id: canonicalSessionId },
        include: { course: true },
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
      return tx.liveSession.findUniqueOrThrow({
        where: { id: session.id },
        include: sessionForProjection,
      });
    });
  }

  async cancelSession(
    sessionId: string,
    caller: { id: string; role: string },
  ): Promise<SessionProjection> {
    const canonicalSessionId = normalizeUuid(sessionId);
    return this.transactions.run(async (tx) => {
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

  async getParticipantSnapshot(
    sessionId: string,
    participantId: string,
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
          select: { liveSessionId: true },
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

  private async transitionQuestion(
    sessionId: string,
    sessionQuestionId: string,
    caller: { id: string; role: string },
    target: 'open' | 'closed',
  ): Promise<SessionQuestionProjection> {
    const canonicalSessionId = normalizeUuid(sessionId);
    const canonicalQuestionId = normalizeUuid(sessionQuestionId);
    return this.transactions.run(async (tx) => {
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
  }

  private assertCourseAccess(
    course: { ownerAccountId: string } | null,
    caller: { id: string; role: string },
  ): asserts course is { ownerAccountId: string } {
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

export function toLiveSessionDto(session: SessionProjection) {
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
