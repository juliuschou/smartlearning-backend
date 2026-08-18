import { Injectable } from '@nestjs/common';
import { Course } from '../../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import { newId } from '../../../common/crypto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../common/errors';
import {
  CourseStatus,
  canArchive,
  isCourseStatus,
} from '../domain/course-status';
import { LiveSessionStatus } from '../../live-sessions/domain';
import { isTeacherOrAdmin } from '../../identity/domain/roles';
import {
  type PageRequest,
  type Page,
  normalizePageRequest,
  toPage,
} from '../../../common/pagination';

/**
 * Course application service — the single write entry point for courses.
 *
 * Invariants enforced here (DB CHECKs guard status values):
 *   - owner immutable (never updated)
 *   - draft → archived is terminal (archived courses reject mutation)
 *   - create requires the caller's `can_create_course === true`
 *     (the CanCreateCourseGuard checks this at the edge; re-asserted here
 *      would be redundant — kept at the guard for single responsibility)
 *
 * Authorization (owner scope): list/detail/archive are owner-scoped; an admin
 * may list/inspect any course (admin = read-across, per US-F16 context).
 */
@Injectable()
export class CourseService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly transactions: TransactionService,
  ) {}

  private get db() {
    return this.prismaService.prisma;
  }

  async createCourse(input: {
    ownerAccountId: string;
    role: string;
    name: string;
    description?: string;
  }): Promise<Course> {
    this.assertTeacherOrAdmin(input.role);
    return this.db.course.create({
      data: {
        id: newId(),
        ownerAccountId: input.ownerAccountId,
        name: input.name,
        description: input.description ?? null,
        status: CourseStatus.DRAFT,
      },
    });
  }

  /** List courses the caller owns (teachers). Admin listing is a later phase. */
  async listOwnedCourses(
    caller: { id: string; role: string },
    raw: { page?: number; pageSize?: number },
  ): Promise<Page<Course>> {
    this.assertTeacherOrAdmin(caller.role);
    const req: PageRequest = normalizePageRequest(raw);
    const where = { ownerAccountId: caller.id };
    const [data, total] = await Promise.all([
      this.db.course.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (req.page - 1) * req.pageSize,
        take: req.pageSize,
      }),
      this.db.course.count({ where }),
    ]);
    return toPage(data, total, req);
  }

  /**
   * Get a course by id. Caller must be the owner (or admin). Throws
   * NotFoundError if missing, ForbiddenError if not authorized.
   */
  async getCourse(
    courseId: string,
    caller: { id: string; role: string },
  ): Promise<Course> {
    this.assertTeacherOrAdmin(caller.role);
    const course = await this.db.course.findUnique({
      where: { id: courseId },
    });
    if (!course) {
      throw new NotFoundError('Course not found', 'id');
    }
    if (course.ownerAccountId !== caller.id && caller.role !== 'admin') {
      // Same error as not-found to avoid leaking existence to non-owners.
      throw new NotFoundError('Course not found', 'id');
    }
    return course;
  }

  /** Archive a draft course (terminal), only when no live session is open. */
  async archiveCourse(
    courseId: string,
    caller: { id: string; role: string },
  ): Promise<Course> {
    this.assertTeacherOrAdmin(caller.role);
    return this.transactions.run(async (tx) => {
      await this.transactions.lockCourseForUpdate(tx, courseId);
      const course = await tx.course.findUnique({ where: { id: courseId } });
      if (
        !course ||
        (course.ownerAccountId !== caller.id && caller.role !== 'admin')
      ) {
        throw new NotFoundError('Course not found', 'id');
      }
      if (!isCourseStatus(course.status)) {
        throw new ConflictError('Invalid course status');
      }
      if (!canArchive(course.status)) {
        throw new ConflictError('Only draft courses can be archived', 'status');
      }
      const openSession = await tx.liveSession.findFirst({
        where: {
          courseId,
          status: {
            in: [LiveSessionStatus.WAITING, LiveSessionStatus.ACTIVE],
          },
        },
        select: { id: true },
      });
      if (openSession) {
        throw new ConflictError(
          'Course cannot be archived while a LiveSession is waiting or active.',
          'status',
        );
      }
      return tx.course.update({
        where: { id: courseId },
        data: { status: CourseStatus.ARCHIVED },
      });
    });
  }

  private assertTeacherOrAdmin(role: string): void {
    if (!isTeacherOrAdmin(role)) {
      throw new ForbiddenError('Teacher or admin role required');
    }
  }
}
