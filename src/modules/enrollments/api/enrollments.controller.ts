import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CsrfGuard,
  CurrentAccount,
  SessionGuard,
  StudentGuard,
  TeacherOrAdminGuard,
} from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import { type Page } from '../../../common/pagination';
import { EnrollmentService } from '../application/enrollment.service';
import {
  CreateEnrollmentDto,
  EnrollmentDto,
  EnrollmentStudentDto,
  MyCourseDto,
} from './dto';
import type {
  EnrolledCourseRow,
  EnrollmentRosterRow,
} from '../application/enrollment.service';

@ApiTags('enrollments')
@Controller({ path: '', version: '1' })
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentService) {}

  @Post('courses/:courseId/enrollments')
  @UseGuards(SessionGuard, CsrfGuard, TeacherOrAdminGuard)
  async add(
    @Param('courseId', new ParseUUIDPipe()) courseId: string,
    @Body() dto: CreateEnrollmentDto,
    @CurrentAccount() auth: AuthContext,
  ): Promise<EnrollmentDto> {
    return toEnrollmentDto(
      await this.enrollments.addEnrollment(
        courseId,
        { id: auth.account.id, role: auth.account.role },
        dto.studentAccountId,
      ),
    );
  }

  @Delete('courses/:courseId/enrollments/:studentAccountId')
  @UseGuards(SessionGuard, CsrfGuard, TeacherOrAdminGuard)
  async remove(
    @Param('courseId', new ParseUUIDPipe()) courseId: string,
    @Param('studentAccountId', new ParseUUIDPipe()) studentAccountId: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<null> {
    await this.enrollments.removeEnrollment(
      courseId,
      { id: auth.account.id, role: auth.account.role },
      studentAccountId,
    );
    return null;
  }

  @Get('courses/:courseId/enrollments')
  @UseGuards(SessionGuard, TeacherOrAdminGuard)
  async list(
    @Param('courseId', new ParseUUIDPipe()) courseId: string,
    @CurrentAccount() auth: AuthContext,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Page<EnrollmentDto>> {
    const result = await this.enrollments.listEnrollments(
      courseId,
      { id: auth.account.id, role: auth.account.role },
      {
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
      },
    );
    return {
      data: result.data.map(toEnrollmentDto),
      meta: result.meta,
    };
  }

  @Get('me/courses')
  @UseGuards(SessionGuard, StudentGuard)
  async myCourses(
    @CurrentAccount() auth: AuthContext,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Page<MyCourseDto>> {
    const result = await this.enrollments.listMyCourses(
      { id: auth.account.id, role: auth.account.role },
      {
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
      },
    );
    return {
      data: result.data.map(toMyCourseDto),
      meta: result.meta,
    };
  }
}

function toEnrollmentDto(row: EnrollmentRosterRow): EnrollmentDto {
  return {
    id: row.id,
    courseId: row.courseId,
    studentAccountId: row.studentAccountId,
    status: row.status,
    enrolledAt: row.enrolledAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    student: toStudentDto(row.studentAccount),
  };
}

function toStudentDto(student: {
  id: string;
  username: string;
  displayName: string;
}): EnrollmentStudentDto {
  return {
    id: student.id,
    username: student.username,
    displayName: student.displayName,
  };
}

function toMyCourseDto(row: EnrolledCourseRow): MyCourseDto {
  return {
    enrollmentId: row.id,
    courseId: row.course.id,
    name: row.course.name,
    description: row.course.description,
    status: row.course.status,
    ownerAccountId: row.course.ownerAccountId,
    enrolledAt: row.enrolledAt.toISOString(),
    createdAt: row.course.createdAt.toISOString(),
    updatedAt: row.course.updatedAt.toISOString(),
  };
}
