import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CourseService } from '../application/course.service';
import {
  SessionGuard,
  CsrfGuard,
  TeacherOrAdminGuard,
  CurrentAccount,
  CourseActorGuard,
  CourseCsrfGuard,
  CurrentCourseActor,
} from '../../../common/auth';
import type { AuthContext, CourseActorContext } from '../../../common/auth';
import {
  CliCourseSummaryDto,
  CreateCourseDto,
  CourseDto,
  ListCoursesQueryDto,
} from './dto/course.dto';
import { type Page } from '../../../common/pagination';
import { ApiExtraModels, ApiHeader, ApiTags } from '@nestjs/swagger';
import { OperationRateLimitGuard } from '../../rate-limit/operation-rate-limit.guard';
import {
  OperationRateLimit,
  OperationRateLimitPolicy,
} from '../../rate-limit/operation-rate-limit';

/**
 * Course endpoints under /api/v1/courses.
 *
 * Slice scope: create (requires can_create_course), list owned, detail,
 * archive. Question/live-session endpoints are later phases.
 */
@ApiTags('courses')
@ApiExtraModels(CourseDto, CliCourseSummaryDto)
@Controller({ path: 'courses', version: '1' })
export class CoursesController {
  constructor(private readonly courses: CourseService) {}

  @Post()
  @ApiHeader({
    name: 'X-CLI-Key',
    required: false,
    description:
      'CLI credential alternative to a Web session. If supplied, invalid credentials do not fall back to cookies.',
  })
  @OperationRateLimit(OperationRateLimitPolicy.CLI_COURSES_CREATE)
  @UseGuards(CourseActorGuard, OperationRateLimitGuard, CourseCsrfGuard)
  async create(
    @Body() dto: CreateCourseDto,
    @CurrentCourseActor() actor: CourseActorContext,
  ): Promise<CourseDto | CliCourseSummaryDto> {
    const course = await this.courses.createCourse({
      ownerAccountId: actor.accountId,
      name: dto.name,
      description: dto.description,
    });
    return actor.kind === 'cli' ? toCliDto(course) : toDto(course);
  }

  @Get()
  @ApiHeader({
    name: 'X-CLI-Key',
    required: false,
    description:
      'CLI credential alternative to a Web session. If supplied, invalid credentials do not fall back to cookies.',
  })
  @OperationRateLimit(OperationRateLimitPolicy.CLI_COURSES_LIST)
  @UseGuards(CourseActorGuard, OperationRateLimitGuard)
  async list(
    @CurrentCourseActor() actor: CourseActorContext,
    @Query() query: ListCoursesQueryDto,
  ): Promise<Page<CourseDto> | Page<CliCourseSummaryDto>> {
    if (actor.kind === 'cli') {
      return this.courses.listOwnedDraftCourseSummaries(
        { id: actor.accountId, role: actor.role },
        query,
      );
    }

    const result = await this.courses.listOwnedCourses(
      { id: actor.accountId, role: actor.role },
      query,
    );
    return {
      data: result.data.map(toDto),
      meta: result.meta,
    };
  }

  @Get(':id')
  @UseGuards(SessionGuard, TeacherOrAdminGuard)
  async detail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<CourseDto> {
    const course = await this.courses.getCourse(id, {
      id: auth.account.id,
      role: auth.account.role,
    });
    return toDto(course);
  }

  @Post(':id/archive')
  @UseGuards(SessionGuard, CsrfGuard, TeacherOrAdminGuard)
  async archive(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<CourseDto> {
    const course = await this.courses.archiveCourse(id, {
      id: auth.account.id,
      role: auth.account.role,
    });
    return toDto(course);
  }
}

function toCliDto(course: {
  id: string;
  name: string;
  status: string;
}): CliCourseSummaryDto {
  return {
    id: course.id,
    name: course.name,
    status: course.status,
  };
}

function toDto(course: {
  id: string;
  name: string;
  description: string | null;
  status: string;
  ownerAccountId: string;
  createdAt: Date;
  updatedAt: Date;
}): CourseDto {
  return {
    id: course.id,
    name: course.name,
    description: course.description,
    status: course.status,
    ownerAccountId: course.ownerAccountId,
    createdAt: course.createdAt.toISOString(),
    updatedAt: course.updatedAt.toISOString(),
  };
}
