import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../../generated/prisma/client';
import type {
  Account,
  Course,
  CourseEnrollment,
} from '../../../../generated/prisma/client';
import { isUuid, newId, normalizeUuid } from '../../../common/crypto';
import {
  ConflictError,
  DomainError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors';
import { HttpStatus } from '@nestjs/common';
import {
  type Page,
  type PageRequest,
  normalizePageRequest,
  toPage,
} from '../../../common/pagination';
import { PrismaService } from '../../../prisma/prisma.service';
import { TransactionService } from '../../../prisma/transaction.service';
import { AccountRole, isTeacherOrAdmin } from '../../identity/domain/roles';
import { AccountStatus } from '../../identity/domain/account-status';
import { CourseStatus } from '../../courses/domain/course-status';
import {
  EnrollmentStatus,
  isEnrollmentStatus,
} from '../domain/enrollment-status';

export type EnrollmentRosterRow = CourseEnrollment & {
  studentAccount: Pick<Account, 'id' | 'username' | 'displayName'>;
};

export type EnrolledCourseRow = CourseEnrollment & {
  course: Course;
};

const rosterStudentSelect = {
  id: true,
  username: true,
  displayName: true,
} as const;

/**
 * Course enrollment application service.
 *
 * Teacher/admin authorization is re-asserted here even though HTTP routes also
 * use role guards. Course rows are locked before roster mutations so add,
 * reactivation, and remove operations serialize per course.
 */
@Injectable()
export class EnrollmentService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly transactions: TransactionService,
  ) {}

  private get db() {
    return this.prismaService.prisma;
  }

  async addEnrollment(
    courseId: string,
    caller: { id: string; role: string },
    studentAccountId: string,
  ): Promise<EnrollmentRosterRow> {
    const canonicalCourseId = this.requireUuid(courseId, 'courseId');
    const canonicalStudentAccountId = this.requireUuid(
      studentAccountId,
      'studentAccountId',
    );
    this.assertTeacherOrAdmin(caller.role);

    return this.transactions.run(async (tx) => {
      await this.transactions.lockCourseForUpdate(tx, canonicalCourseId);
      const course = await tx.course.findUnique({
        where: { id: canonicalCourseId },
      });
      this.assertCourseAccess(course, caller);
      if (course.status !== CourseStatus.DRAFT) {
        throw new DomainError(
          ErrorCode.COURSE_NOT_EDITABLE,
          'Archived courses cannot change their enrollment roster',
          HttpStatus.CONFLICT,
          'courseId',
        );
      }

      const student = await tx.account.findUnique({
        where: { id: canonicalStudentAccountId },
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
          status: true,
        },
      });
      if (
        !student ||
        student.role !== AccountRole.STUDENT ||
        student.status !== AccountStatus.ACTIVE
      ) {
        throw new NotFoundError(
          'Student account not found',
          'studentAccountId',
        );
      }

      const existing = await tx.courseEnrollment.findUnique({
        where: {
          courseId_studentAccountId: {
            courseId: canonicalCourseId,
            studentAccountId: canonicalStudentAccountId,
          },
        },
      });

      if (existing) {
        if (!isEnrollmentStatus(existing.status)) {
          throw new ConflictError('Invalid enrollment status', 'status');
        }
        if (existing.status === EnrollmentStatus.ACTIVE) {
          const current = await this.findRosterRow(
            tx,
            canonicalCourseId,
            canonicalStudentAccountId,
          );
          if (!current) {
            throw new ConflictError('Enrollment could not be loaded');
          }
          return current;
        }
        return tx.courseEnrollment.update({
          where: { id: existing.id },
          data: {
            status: EnrollmentStatus.ACTIVE,
            enrolledAt: new Date(),
          },
          include: { studentAccount: { select: rosterStudentSelect } },
        });
      }

      return tx.courseEnrollment.create({
        data: {
          id: newId(),
          courseId: canonicalCourseId,
          studentAccountId: canonicalStudentAccountId,
          status: EnrollmentStatus.ACTIVE,
        },
        include: { studentAccount: { select: rosterStudentSelect } },
      });
    });
  }

  /**
   * Mark a roster row removed. Repeated removal is intentionally idempotent;
   * the course owner/admin receives the same successful empty response whether
   * the row was active, already removed, or absent.
   */
  async removeEnrollment(
    courseId: string,
    caller: { id: string; role: string },
    studentAccountId: string,
  ): Promise<void> {
    const canonicalCourseId = this.requireUuid(courseId, 'courseId');
    const canonicalStudentAccountId = this.requireUuid(
      studentAccountId,
      'studentAccountId',
    );
    this.assertTeacherOrAdmin(caller.role);

    await this.transactions.run(async (tx) => {
      await this.transactions.lockCourseForUpdate(tx, canonicalCourseId);
      const course = await tx.course.findUnique({
        where: { id: canonicalCourseId },
      });
      this.assertCourseAccess(course, caller);

      await tx.courseEnrollment.updateMany({
        where: {
          courseId: canonicalCourseId,
          studentAccountId: canonicalStudentAccountId,
        },
        data: { status: EnrollmentStatus.REMOVED },
      });
    });
  }

  async listEnrollments(
    courseId: string,
    caller: { id: string; role: string },
    raw: { page?: number; pageSize?: number },
  ): Promise<Page<EnrollmentRosterRow>> {
    const canonicalCourseId = this.requireUuid(courseId, 'courseId');
    this.assertTeacherOrAdmin(caller.role);
    const course = await this.db.course.findUnique({
      where: { id: canonicalCourseId },
    });
    this.assertCourseAccess(course, caller);

    const req = this.normalizeListRequest(raw);
    const where = { courseId: canonicalCourseId };
    const [data, total] = await Promise.all([
      this.db.courseEnrollment.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (req.page - 1) * req.pageSize,
        take: req.pageSize,
        include: { studentAccount: { select: rosterStudentSelect } },
      }),
      this.db.courseEnrollment.count({ where }),
    ]);
    return toPage(data, total, req);
  }

  async listMyCourses(
    caller: { id: string; role: string },
    raw: { page?: number; pageSize?: number },
  ): Promise<Page<EnrolledCourseRow>> {
    if (caller.role !== AccountRole.STUDENT) {
      throw new ForbiddenError('Student role required');
    }
    const req = this.normalizeListRequest(raw);
    const where = {
      studentAccountId: caller.id,
      status: EnrollmentStatus.ACTIVE,
    };
    const [data, total] = await Promise.all([
      this.db.courseEnrollment.findMany({
        where,
        orderBy: [{ enrolledAt: 'desc' }, { id: 'desc' }],
        skip: (req.page - 1) * req.pageSize,
        take: req.pageSize,
        include: { course: true },
      }),
      this.db.courseEnrollment.count({ where }),
    ]);
    return toPage(data, total, req);
  }

  /**
   * Shared authorization primitive for cookie-bound participant identity.
   * It deliberately returns a generic forbidden error so a student cannot use
   * this check to probe whether another course has a roster row.
   */
  async assertActiveEnrollment(
    courseId: string,
    studentAccountId: string,
  ): Promise<CourseEnrollment> {
    const canonicalCourseId = this.requireUuid(courseId, 'courseId');
    const canonicalStudentAccountId = this.requireUuid(
      studentAccountId,
      'studentAccountId',
    );
    const enrollment = await this.db.courseEnrollment.findUnique({
      where: {
        courseId_studentAccountId: {
          courseId: canonicalCourseId,
          studentAccountId: canonicalStudentAccountId,
        },
      },
    });
    if (!enrollment || enrollment.status !== EnrollmentStatus.ACTIVE) {
      throw new ForbiddenError('Active course enrollment required');
    }
    return enrollment;
  }

  private async findRosterRow(
    tx: Prisma.TransactionClient,
    courseId: string,
    studentAccountId: string,
  ): Promise<EnrollmentRosterRow | null> {
    return tx.courseEnrollment.findUnique({
      where: {
        courseId_studentAccountId: {
          courseId,
          studentAccountId,
        },
      },
      include: { studentAccount: { select: rosterStudentSelect } },
    });
  }

  private assertCourseAccess(
    course: Course | null,
    caller: { id: string; role: string },
  ): asserts course is Course {
    if (
      !course ||
      (course.ownerAccountId !== caller.id && caller.role !== AccountRole.ADMIN)
    ) {
      throw new NotFoundError('Course not found', 'courseId');
    }
  }

  private assertTeacherOrAdmin(role: string): void {
    if (!isTeacherOrAdmin(role)) {
      throw new ForbiddenError('Teacher or admin role required');
    }
  }

  private requireUuid(value: string, field: string): string {
    if (!isUuid(value)) {
      throw new ValidationError('Invalid UUID', field);
    }
    return normalizeUuid(value);
  }

  private normalizeListRequest(raw: {
    page?: number;
    pageSize?: number;
  }): PageRequest {
    return normalizePageRequest({
      page: raw.page !== undefined && Number.isFinite(raw.page) ? raw.page : 1,
      pageSize:
        raw.pageSize !== undefined && Number.isFinite(raw.pageSize)
          ? raw.pageSize
          : undefined,
    });
  }
}
