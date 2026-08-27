import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

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
}
