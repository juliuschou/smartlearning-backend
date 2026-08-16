import { Module } from '@nestjs/common';
import { CoursesController } from './api/courses.controller';
import { CourseService } from './application/course.service';

/**
 * Courses bounded context. Slice scope: create/list/detail/archive.
 * AuthModule (guards) is global, so it is not imported here.
 */
@Module({
  controllers: [CoursesController],
  providers: [CourseService],
  exports: [CourseService],
})
export class CoursesModule {}
