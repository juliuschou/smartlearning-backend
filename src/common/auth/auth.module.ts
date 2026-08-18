import { Global, Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionGuard } from './session.guard';
import { CsrfGuard } from './csrf.guard';
import {
  AdminGuard,
  CanCreateCourseGuard,
  StudentGuard,
  TeacherOrAdminGuard,
} from './authorization.guards';
import { StepUpGuard } from './step-up.guard';

/**
 * Global auth wiring: session resolution + role/permission guards.
 * Exported so feature modules apply guards via `@UseGuards()` without
 * importing AuthModule (guards are DI-managed via this module's providers).
 */
@Global()
@Module({
  providers: [
    SessionService,
    SessionGuard,
    CsrfGuard,
    AdminGuard,
    CanCreateCourseGuard,
    StudentGuard,
    TeacherOrAdminGuard,
    StepUpGuard,
  ],
  exports: [
    SessionService,
    SessionGuard,
    CsrfGuard,
    AdminGuard,
    CanCreateCourseGuard,
    StudentGuard,
    TeacherOrAdminGuard,
    StepUpGuard,
  ],
})
export class AuthModule {}
