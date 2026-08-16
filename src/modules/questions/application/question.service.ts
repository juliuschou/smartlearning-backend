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
import { TransactionService } from '../../../prisma/transaction.service';
import {
  normalizePollSingleChoice,
  validatePollSingleChoice,
} from '../domain/poll-single-choice';
import type { CreateQuestionDto } from '../api/dto';

export type QuestionWithOptions = QuestionDefinition & {
  options: QuestionOption[];
};

@Injectable()
export class QuestionService {
  constructor(private readonly transactions: TransactionService) {}

  async createQuestion(
    courseId: string,
    caller: { id: string; role: string },
    dto: CreateQuestionDto,
  ): Promise<QuestionWithOptions> {
    const normalized = normalizePollSingleChoice(dto);
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
              isCorrect: false,
            })),
          },
        },
        include: { options: { orderBy: { position: 'asc' } } },
      });
    });
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

export function toQuestionDto(question: QuestionWithOptions) {
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
    })),
    createdAt: question.createdAt.toISOString(),
    updatedAt: question.updatedAt.toISOString(),
  };
}
