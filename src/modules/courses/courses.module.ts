import { Module } from '@nestjs/common';
import { CoursesController } from './api/courses.controller';
import { CourseService } from './application/course.service';
import { IdentityModule } from '../identity/identity.module';
import { CourseActorGuard, CourseCsrfGuard } from '../../common/auth';

/**
 * Courses bounded context. Slice scope: create/list/detail/archive.
 * AuthModule (guards) is global, so it is not imported here.
 */
@Module({
  imports: [IdentityModule],
  controllers: [CoursesController],
  providers: [CourseService, CourseActorGuard, CourseCsrfGuard],
  exports: [CourseService],
})
export class CoursesModule {}
