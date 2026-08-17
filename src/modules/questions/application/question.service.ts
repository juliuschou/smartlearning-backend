import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  QuestionDefinition,
  QuestionOption,
} from '../../../../generated/prisma/client';
import { newId, normalizeUuid } from '../../../common/crypto';
import {
  ConflictError,
  DomainError,
  NotFoundError,
} from '../../../common/errors';
import { CourseStatus } from '../../courses/domain/course-status';
import { LiveSessionStatus } from '../../live-sessions/domain';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import {
  type PageRequest,
  type Page,
  normalizePageRequest,
  toPage,
} from '../../../common/pagination';
import { validatePollSingleChoice } from '../domain/poll-single-choice';
import {
  normalizeQuestion,
  type NormalizedQuestion,
} from '../domain/question-contract';
import type { CreateQuestionDto, UpdateQuestionDto } from '../api/dto';

export type QuestionWithOptions = QuestionDefinition & {
  options: QuestionOption[];
};

@Injectable()
export class QuestionService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly transactions: TransactionService,
  ) {}

  private get db() {
    return this.prismaService.prisma;
  }

  async createQuestion(
    courseId: string,
    caller: { id: string; role: string },
    dto: CreateQuestionDto,
  ): Promise<QuestionWithOptions> {
    const normalized = normalizeQuestion(dto);
    const canonicalCourseId = normalizeUuid(courseId);
    return this.transactions.run(async (tx) => {
      await this.transactions.lockCourseForAppend(tx, canonicalCourseId);
      await this.transactions.lockCourseForUpdate(tx, canonicalCourseId);
      const course = await tx.course.findUnique({
        where: { id: canonicalCourseId },
      });
      this.assertCourseWritable(course, caller);

      const maxPosition = await tx.questionDefinition.aggregate({
        where: { courseId: canonicalCourseId },
        _max: { position: true },
      });
      const position = (maxPosition._max.position ?? 0) + 1;
      return tx.questionDefinition.create({
        data: {
          id: newId(),
          courseId: canonicalCourseId,
          type: normalized.type,
          prompt: normalized.prompt,
          selectionMode: normalized.selectionMode,
          position,
          options: {
            create: normalized.options.map((option) => ({
              id: newId(),
              optionRef: option.optionRef,
              text: option.text,
              position: option.position,
              isCorrect: isCorrectOption(normalized, option.optionRef),
            })),
          },
        },
        include: { options: { orderBy: { position: 'asc' } } },
      });
    });
  }

  /**
   * List questions for a course (paginated, ordered by position ascending).
   * Reads are allowed for the course owner or an admin on any course state
   * (including archived); non-owners receive NOT_FOUND to avoid leaking
   * existence. Mirrors the `getCourse` authorization semantics.
   */
  async listQuestions(
    courseId: string,
    caller: { id: string; role: string },
    raw: { page?: number; pageSize?: number },
  ): Promise<Page<QuestionWithOptions>> {
    const canonicalCourseId = normalizeUuid(courseId);
    const course = await this.db.course.findUnique({
      where: { id: canonicalCourseId },
    });
    this.assertCourseReadable(course, caller);

    const req: PageRequest = normalizePageRequest(raw);
    const where = { courseId: canonicalCourseId };
    const [data, total] = await Promise.all([
      this.db.questionDefinition.findMany({
        where,
        orderBy: { position: 'asc' },
        include: { options: { orderBy: { position: 'asc' } } },
        skip: (req.page - 1) * req.pageSize,
        take: req.pageSize,
      }),
      this.db.questionDefinition.count({ where }),
    ]);
    return toPage(data, total, req);
  }

  /**
   * Get a single question by id within a course. Owner/admin may read any
   * course state; non-owners receive NOT_FOUND. A question that does not
   * belong to the (accessible) course also returns NOT_FOUND.
   */
  async getQuestion(
    courseId: string,
    questionId: string,
    caller: { id: string; role: string },
  ): Promise<QuestionWithOptions> {
    const canonicalCourseId = normalizeUuid(courseId);
    const canonicalQuestionId = normalizeUuid(questionId);
    const course = await this.db.course.findUnique({
      where: { id: canonicalCourseId },
    });
    this.assertCourseReadable(course, caller);

    const question = await this.db.questionDefinition.findUnique({
      where: {
        id_courseId: { id: canonicalQuestionId, courseId: canonicalCourseId },
      },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    if (!question) {
      throw new NotFoundError('Question not found', 'id');
    }
    return question;
  }

  /**
   * Full-replace update of a question's prompt/options (same poll/single
   * contract). Options are deleted and recreated to avoid optionRef/position
   * partial-merge conflicts; `position` is preserved. The persisted type/
   * selectionMode must match the DTO (no type change within this slice).
   * Draft-only, owner/admin, and locked-by-session enforced.
   */
  async updateQuestion(
    courseId: string,
    questionId: string,
    caller: { id: string; role: string },
    dto: UpdateQuestionDto,
  ): Promise<QuestionWithOptions> {
    const normalized = normalizeQuestion(dto);
    const canonicalCourseId = normalizeUuid(courseId);
    const canonicalQuestionId = normalizeUuid(questionId);
    return this.transactions.run(async (tx) => {
      await this.transactions.lockCourseForAppend(tx, canonicalCourseId);
      await this.transactions.lockCourseForUpdate(tx, canonicalCourseId);
      const course = await tx.course.findUnique({
        where: { id: canonicalCourseId },
      });
      this.assertCourseWritable(course, caller);

      const existing = await tx.questionDefinition.findUnique({
        where: {
          id_courseId: {
            id: canonicalQuestionId,
            courseId: canonicalCourseId,
          },
        },
      });
      if (!existing) {
        throw new NotFoundError('Question not found', 'id');
      }
      if (
        existing.type !== normalized.type ||
        existing.selectionMode !== normalized.selectionMode
      ) {
        throw new ConflictError(
          'Question type/selectionMode cannot be changed.',
          'type',
        );
      }

      await this.assertNotLockedBySession(tx, canonicalCourseId, [
        canonicalQuestionId,
      ]);

      // Full-replace options; keep the question row id and position.
      await tx.questionOption.deleteMany({
        where: { questionDefinitionId: canonicalQuestionId },
      });
      return tx.questionDefinition.update({
        where: { id: canonicalQuestionId },
        data: {
          prompt: normalized.prompt,
          options: {
            create: normalized.options.map((option) => ({
              id: newId(),
              optionRef: option.optionRef,
              text: option.text,
              position: option.position,
              isCorrect: isCorrectOption(normalized, option.optionRef),
            })),
          },
        },
        include: { options: { orderBy: { position: 'asc' } } },
      });
    });
  }

  /**
   * Delete a question and compact remaining course positions to a contiguous
   * 1..N sequence. Draft-only, owner/admin, and locked-by-session enforced.
   */
  async deleteQuestion(
    courseId: string,
    questionId: string,
    caller: { id: string; role: string },
  ): Promise<void> {
    const canonicalCourseId = normalizeUuid(courseId);
    const canonicalQuestionId = normalizeUuid(questionId);
    await this.transactions.run(async (tx) => {
      await this.transactions.lockCourseForAppend(tx, canonicalCourseId);
      await this.transactions.lockCourseForUpdate(tx, canonicalCourseId);
      const course = await tx.course.findUnique({
        where: { id: canonicalCourseId },
      });
      this.assertCourseWritable(course, caller);

      const existing = await tx.questionDefinition.findUnique({
        where: {
          id_courseId: {
            id: canonicalQuestionId,
            courseId: canonicalCourseId,
          },
        },
        select: { id: true, position: true },
      });
      if (!existing) {
        throw new NotFoundError('Question not found', 'id');
      }
      await this.assertNotLockedBySession(tx, canonicalCourseId, [
        canonicalQuestionId,
      ]);

      await tx.questionDefinition.delete({
        where: { id: canonicalQuestionId },
      });
      await this.compactPositions(tx, canonicalCourseId);
    });
  }

  /**
   * Reorder all questions in a course to match the submitted full ID order.
   * Uses a two-phase position assignment (temporary high positions, then final
   * 1..N) to avoid transient violations of the `(courseId, position)` unique
   * constraint. Draft-only, owner/admin, and locked-by-session enforced.
   */
  async reorderQuestions(
    courseId: string,
    caller: { id: string; role: string },
    questionIds: readonly string[],
  ): Promise<QuestionWithOptions[]> {
    const canonicalCourseId = normalizeUuid(courseId);
    const canonicalQuestionIds = questionIds.map(normalizeUuid);
    const uniqueIds = [...new Set(canonicalQuestionIds)];
    if (
      uniqueIds.length !== canonicalQuestionIds.length ||
      uniqueIds.length === 0
    ) {
      throw new ConflictError(
        'Reorder must contain unique, non-empty question IDs.',
        'questionIds',
      );
    }
    return this.transactions.run(async (tx) => {
      await this.transactions.lockCourseForAppend(tx, canonicalCourseId);
      await this.transactions.lockCourseForUpdate(tx, canonicalCourseId);
      const course = await tx.course.findUnique({
        where: { id: canonicalCourseId },
      });
      this.assertCourseWritable(course, caller);

      const existing = await tx.questionDefinition.findMany({
        where: { courseId: canonicalCourseId },
        select: { id: true, position: true },
      });
      const existingIds = new Set(existing.map((q) => q.id));
      const submittedSet = new Set(canonicalQuestionIds);
      if (existingIds.size !== submittedSet.size) {
        throw new ConflictError(
          'Reorder must include exactly the course questions.',
          'questionIds',
        );
      }
      for (const id of canonicalQuestionIds) {
        if (!existingIds.has(id)) {
          throw new ConflictError(
            'Reorder must include exactly the course questions.',
            'questionIds',
          );
        }
      }
      await this.assertNotLockedBySession(tx, canonicalCourseId, uniqueIds);

      const maxPosition = existing.reduce(
        (max, q) => Math.max(max, q.position),
        0,
      );
      const temporaryBase =
        Math.max(maxPosition, uniqueIds.length) + uniqueIds.length + 1;

      // Phase 1: move every question to a distinct temporary high position.
      await Promise.all(
        canonicalQuestionIds.map((id, index) =>
          tx.questionDefinition.update({
            where: { id },
            data: { position: temporaryBase + index },
          }),
        ),
      );
      // Phase 2: assign final 1..N in the requested order.
      await Promise.all(
        canonicalQuestionIds.map((id, index) =>
          tx.questionDefinition.update({
            where: { id },
            data: { position: index + 1 },
          }),
        ),
      );

      return tx.questionDefinition.findMany({
        where: { courseId: canonicalCourseId },
        orderBy: { position: 'asc' },
        include: { options: { orderBy: { position: 'asc' } } },
      });
    });
  }

  /**
   * Append a batch of normalized questions to a course inside the caller's
   * transaction. Reuses the create lock sequence + writable assertion and
   * assigns sequential positions in preview order. Used by batch confirm
   * (all-or-nothing): any failure rolls back the whole transaction.
   */
  async appendBatchInTransaction(
    tx: Prisma.TransactionClient,
    courseId: string,
    caller: { id: string; role: string },
    normalized: NormalizedQuestion[],
  ): Promise<QuestionWithOptions[]> {
    const canonicalCourseId = normalizeUuid(courseId);
    await this.transactions.lockCourseForAppend(tx, canonicalCourseId);
    await this.transactions.lockCourseForUpdate(tx, canonicalCourseId);
    const course = await tx.course.findUnique({
      where: { id: canonicalCourseId },
    });
    this.assertCourseWritable(course, caller);

    const maxPosition = await tx.questionDefinition.aggregate({
      where: { courseId: canonicalCourseId },
      _max: { position: true },
    });
    let position = (maxPosition._max.position ?? 0) + 1;
    const created: QuestionWithOptions[] = [];
    for (const normalizedQuestion of normalized) {
      const question = await tx.questionDefinition.create({
        data: {
          id: newId(),
          courseId: canonicalCourseId,
          type: normalizedQuestion.type,
          prompt: normalizedQuestion.prompt,
          selectionMode: normalizedQuestion.selectionMode,
          position,
          options: {
            create: normalizedQuestion.options.map((option) => ({
              id: newId(),
              optionRef: option.optionRef,
              text: option.text,
              position: option.position,
              isCorrect: isCorrectOption(normalizedQuestion, option.optionRef),
            })),
          },
        },
        include: { options: { orderBy: { position: 'asc' } } },
      });
      created.push(question);
      position += 1;
    }
    return created;
  }

  /** Load the selected source questions inside the activation transaction. */
  async findForActivation(
    tx: Prisma.TransactionClient,
    courseId: string,
    questionIds: readonly string[],
  ): Promise<QuestionWithOptions[]> {
    const canonicalCourseId = normalizeUuid(courseId);
    const canonicalQuestionIds = questionIds.map(normalizeUuid);
    const uniqueIds = [...new Set(canonicalQuestionIds)];
    if (
      uniqueIds.length !== canonicalQuestionIds.length ||
      uniqueIds.length === 0
    ) {
      throw new ConflictError(
        'Question selection must contain unique question IDs.',
        'questionIds',
      );
    }

    const questions = await tx.questionDefinition.findMany({
      where: { courseId: canonicalCourseId, id: { in: uniqueIds } },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    const byId = new Map(questions.map((question) => [question.id, question]));
    const ordered: QuestionWithOptions[] = [];
    for (const id of canonicalQuestionIds) {
      const question = byId.get(id);
      if (!question)
        throw new NotFoundError('Question not found', 'questionIds');
      if (question.type !== 'poll' || question.selectionMode !== 'single') {
        throw new ConflictError(
          'Only poll single-choice questions are supported.',
          'questionIds',
        );
      }
      if (question.options.length < 2 || question.options.length > 10) {
        throw new ConflictError(
          'Poll source question must contain 2 to 10 options.',
          'questionIds',
        );
      }
      const issues = validatePollSingleChoice({
        type: question.type,
        prompt: question.prompt,
        selectionMode: question.selectionMode,
        options: question.options.map((option) => ({
          optionRef: option.optionRef ?? undefined,
          text: option.text,
        })),
      });
      if (issues.length > 0) {
        throw new ConflictError(
          'Poll source question no longer satisfies the poll contract.',
          'questionIds',
        );
      }
      ordered.push(question);
    }
    return ordered;
  }

  /**
   * Reject mutation of a question that is currently selected by a waiting or
   * active LiveSession. Throws `QUESTION_LOCKED_BY_SESSION` (409) if any of the
   * given question IDs is referenced by such a session's selection.
   */
  private async assertNotLockedBySession(
    tx: Prisma.TransactionClient,
    courseId: string,
    questionIds: readonly string[],
  ): Promise<void> {
    const locked = await tx.liveSessionQuestionSelection.findFirst({
      where: {
        courseId,
        questionDefinitionId: { in: [...questionIds] },
        liveSession: {
          is: {
            status: {
              in: [LiveSessionStatus.WAITING, LiveSessionStatus.ACTIVE],
            },
          },
        },
      },
      select: { id: true },
    });
    if (locked) {
      throw new DomainError(
        'QUESTION_LOCKED_BY_SESSION',
        'Question is selected by a waiting or active LiveSession.',
        409,
        'questionId',
        'Close or cancel the LiveSession before modifying the question.',
      );
    }
  }

  /** Renumber remaining questions to a contiguous 1..N by current position order. */
  private async compactPositions(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<void> {
    const remaining = await tx.questionDefinition.findMany({
      where: { courseId },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });
    const maxPosition = remaining.reduce(
      (max, q) => Math.max(max, q.position),
      0,
    );
    if (remaining.length === 0) return;
    const temporaryBase =
      Math.max(maxPosition, remaining.length) + remaining.length + 1;
    // Two-phase: temporary high positions, then final 1..N, to avoid transient
    // (courseId, position) unique violations during compaction.
    await Promise.all(
      remaining.map((q, index) =>
        tx.questionDefinition.update({
          where: { id: q.id },
          data: { position: temporaryBase + index },
        }),
      ),
    );
    await Promise.all(
      remaining.map((q, index) =>
        tx.questionDefinition.update({
          where: { id: q.id },
          data: { position: index + 1 },
        }),
      ),
    );
  }

  /**
   * Read-access check: owner or admin may read any course state (including
   * archived). Missing course or unauthorized non-owner both return
   * NOT_FOUND to avoid leaking course existence. Unlike
   * `assertCourseWritable`, this does NOT reject archived courses.
   */
  private assertCourseReadable(
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

  private assertCourseWritable(
    course: { ownerAccountId: string; status: string } | null,
    caller: { id: string; role: string },
  ): asserts course is { ownerAccountId: string; status: string } {
    if (
      !course ||
      (course.ownerAccountId !== caller.id && caller.role !== 'admin')
    ) {
      throw new NotFoundError('Course not found', 'courseId');
    }
    if (course.status !== CourseStatus.DRAFT) {
      throw new DomainError(
        'COURSE_NOT_EDITABLE',
        'Course is not editable.',
        409,
        'courseId',
        'Use a draft Course before changing its questions.',
      );
    }
  }
}

/**
 * Authoring projection — exposes `isCorrect`/`correctOptionRefs` for teachers
 * authoring questions. Learner/session projections (`toLearnerQuestionDto`)
 * must NOT expose correctness.
 */
export function toQuestionDto(question: QuestionWithOptions) {
  const correctOptionRefs = question.options
    .filter((o) => o.isCorrect && o.optionRef)
    .map((o) => o.optionRef as string);
  return {
    id: question.id,
    courseId: question.courseId,
    type: question.type,
    prompt: question.prompt,
    selectionMode: question.selectionMode,
    position: question.position,
    options: question.options.map((option) => ({
      id: option.id,
      optionRef: option.optionRef,
      text: option.text,
      position: option.position,
      isCorrect: option.isCorrect,
    })),
    correctOptionRefs,
    createdAt: question.createdAt.toISOString(),
    updatedAt: question.updatedAt.toISOString(),
  };
}

/** Resolve `isCorrect` for a normalized option from the quiz correct refs. */
function isCorrectOption(
  normalized: NormalizedQuestion,
  optionRef: string | null,
): boolean {
  if (normalized.type !== 'quiz' || optionRef === null) return false;
  return normalized.correctOptionRefs.includes(optionRef);
}
