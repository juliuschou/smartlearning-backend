import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenError } from '../errors';
import {
  AccountRole,
  isAccountRole,
} from '../../modules/identity/domain/roles';
import type { AuthContext } from './auth-context';

function authContextOf(req: Request): AuthContext | undefined {
  return (req as Request & { authContext?: AuthContext }).authContext;
}

/**
 * Requires the caller to be an active admin. Compose after SessionGuard.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const auth = authContextOf(ctx.switchToHttp().getRequest<Request>());
    if (!auth) {
      throw new ForbiddenError();
    }
    if (
      !isAccountRole(auth.account.role) ||
      auth.account.role !== AccountRole.ADMIN
    ) {
      throw new ForbiddenError('Admin role required');
    }
    return true;
  }
}

/**
 * Requires a teacher or admin Web Session for teacher-owned resources.
 * Compose after SessionGuard; resource services retain ownership checks.
 */
@Injectable()
export class TeacherOrAdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const auth = authContextOf(ctx.switchToHttp().getRequest<Request>());
    if (!auth) {
      throw new ForbiddenError();
    }
    if (
      !isAccountRole(auth.account.role) ||
      (auth.account.role !== AccountRole.ADMIN &&
        auth.account.role !== AccountRole.TEACHER)
    ) {
      throw new ForbiddenError('Teacher or admin role required');
    }
    return true;
  }
}

/**
 * Requires an authenticated student Web Session.
 */
@Injectable()
export class StudentGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const auth = authContextOf(ctx.switchToHttp().getRequest<Request>());
    if (!auth) {
      throw new ForbiddenError();
    }
    if (
      !isAccountRole(auth.account.role) ||
      auth.account.role !== AccountRole.STUDENT
    ) {
      throw new ForbiddenError('Student role required');
    }
    return true;
  }
}

/**
 * Requires the caller's account to have `can_create_course === true`.
 * Only blocks new course creation — does not revoke existing courses (US-F16).
 * Compose after SessionGuard.
 */
@Injectable()
export class CanCreateCourseGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const auth = authContextOf(ctx.switchToHttp().getRequest<Request>());
    if (!auth) {
      throw new ForbiddenError();
    }
    if (
      !isAccountRole(auth.account.role) ||
      auth.account.role === AccountRole.STUDENT ||
      !auth.account.canCreateCourse
    ) {
      throw new ForbiddenError(
        'Course creation is not permitted for this account',
      );
    }
    return true;
  }
}
