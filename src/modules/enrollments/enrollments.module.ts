import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrollmentsController } from './api/enrollments.controller';
import { EnrollmentService } from './application/enrollment.service';

/**
 * Enrollment bounded context. Course ownership and account role checks remain
 * in the application service; CoursesModule is not made dependent on this
 * module, avoiding a circular dependency.
 */
@Module({
  imports: [IdentityModule, CoursesModule],
  controllers: [EnrollmentsController],
  providers: [EnrollmentService],
  exports: [EnrollmentService],
})
export class EnrollmentsModule {}
