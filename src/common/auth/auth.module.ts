import { Global, Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionGuard } from './session.guard';
import { AdminGuard, CanCreateCourseGuard } from './authorization.guards';

/**
 * Global auth wiring: session resolution + role/permission guards.
 * Exported so feature modules apply guards via `@UseGuards()` without
 * importing AuthModule (guards are DI-managed via this module's providers).
 */
@Global()
@Module({
  providers: [SessionService, SessionGuard, AdminGuard, CanCreateCourseGuard],
  exports: [SessionService, SessionGuard, AdminGuard, CanCreateCourseGuard],
})
export class AuthModule {}
