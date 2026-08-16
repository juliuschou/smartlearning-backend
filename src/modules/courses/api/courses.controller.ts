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
  CanCreateCourseGuard,
  CurrentAccount,
} from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import { CreateCourseDto, CourseDto } from './dto/course.dto';
import { type Page } from '../../../common/pagination';

/**
 * Course endpoints under /api/v1/courses.
 *
 * Slice scope: create (requires can_create_course), list owned, detail,
 * archive. Question/live-session endpoints are later phases.
 */
@Controller({ path: 'courses', version: '1' })
export class CoursesController {
  constructor(private readonly courses: CourseService) {}

  @Post()
  @UseGuards(SessionGuard, CsrfGuard, CanCreateCourseGuard)
  async create(
    @Body() dto: CreateCourseDto,
    @CurrentAccount() auth: AuthContext,
  ): Promise<CourseDto> {
    const course = await this.courses.createCourse({
      ownerAccountId: auth.account.id,
      name: dto.name,
      description: dto.description,
    });
    return toDto(course);
  }

  @Get()
  @UseGuards(SessionGuard)
  async list(
    @CurrentAccount() auth: AuthContext,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Page<CourseDto>> {
    const result = await this.courses.listOwnedCourses(auth.account.id, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
    return {
      data: result.data.map(toDto),
      meta: result.meta,
    };
  }

  @Get(':id')
  @UseGuards(SessionGuard)
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
  @UseGuards(SessionGuard, CsrfGuard)
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
