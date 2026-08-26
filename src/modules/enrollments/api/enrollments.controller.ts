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
import {
  ApiBody,
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { MAX_PAGE_SIZE } from '../../../common/pagination';
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
@ApiExtraModels(
  CreateEnrollmentDto,
  EnrollmentDto,
  EnrollmentStudentDto,
  MyCourseDto,
)
@Controller({ path: '', version: '1' })
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentService) {}

  @Post('courses/:courseId/enrollments')
  @ApiOperation({ summary: 'Add or reactivate a student enrollment' })
  @ApiParam({ name: 'courseId', format: 'uuid' })
  @ApiBody({ type: CreateEnrollmentDto })
  @ApiResponse({ status: 201, type: EnrollmentDto })
  @ApiResponse({
    status: 409,
    description: 'Archived course cannot change its enrollment roster',
    schema: {
      type: 'object',
      properties: {
        data: { nullable: true, type: 'object' },
        meta: { type: 'object' },
        error: {
          type: 'object',
          properties: {
            code: { enum: ['COURSE_NOT_EDITABLE'] },
            field: { type: 'string', example: 'courseId' },
          },
        },
      },
    },
  })
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
  @ApiOperation({ summary: 'List a course enrollment roster' })
  @ApiParam({ name: 'courseId', format: 'uuid' })
  @ApiQuery({ name: 'page', required: false, type: Number, minimum: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { $ref: getSchemaPath(EnrollmentDto) } },
        meta: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
      },
    },
  })
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
  @ApiOperation({ summary: 'List the authenticated student courses' })
  @ApiQuery({ name: 'page', required: false, type: Number, minimum: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { $ref: getSchemaPath(MyCourseDto) } },
        meta: { type: 'object' },
      },
    },
  })
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
