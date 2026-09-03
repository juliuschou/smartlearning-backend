import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow, IsUUID } from 'class-validator';
import { MAX_PAGE_SIZE } from '../../../../common/pagination';

/** Add or reactivate one student in a course roster. */
export class CreateEnrollmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  studentAccountId!: string;
}

/** Safe account projection embedded in a teacher/admin roster response. */
export class EnrollmentStudentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  displayName!: string;
}

/** Persistent course-roster membership projection. */
export class EnrollmentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  courseId!: string;

  @ApiProperty()
  studentAccountId!: string;

  @ApiProperty({ enum: ['active', 'removed'] })
  status!: string;

  @ApiProperty()
  enrolledAt!: string;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;

  @ApiProperty({ type: () => EnrollmentStudentDto })
  student!: EnrollmentStudentDto;
}

/** Minimal current classroom projection for student course discovery. */
export class CurrentJoinableSessionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  sessionCode!: string;

  @ApiProperty({ enum: ['waiting', 'active'] })
  status!: 'waiting' | 'active';
}

/** Course projection returned for an authenticated student's active roster. */
export class MyCourseDto {
  @ApiProperty()
  enrollmentId!: string;

  @ApiProperty()
  courseId!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  ownerAccountId!: string;

  @ApiProperty()
  enrolledAt!: string;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;

  @ApiProperty({ type: () => CurrentJoinableSessionDto, nullable: true })
  currentJoinableSession!: CurrentJoinableSessionDto | null;
}

/** Query contract for the teacher/admin course-scoped student search. */
export class StudentSearchQueryDto {
  /**
   * `q` is validated after course authorization in the application service so
   * hidden courses cannot be probed with malformed search input.
   */
  @ApiProperty({ minLength: 2, maxLength: 100 })
  @Allow()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  q!: unknown;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @Allow()
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: 20 })
  @Allow()
  @Type(() => Number)
  pageSize?: number;
}

/** Safe account + course-relative enrollment projection for student search. */
export class StudentSearchResultDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ enum: ['active', 'removed'], nullable: true })
  enrollmentStatus!: 'active' | 'removed' | null;
}
