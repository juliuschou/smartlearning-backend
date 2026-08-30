import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CsrfGuard } from './csrf.guard';
import { COURSE_ACTOR_KEY } from './course-actor.guard';

/** Conditional CSRF for Course collection mutations. Must follow CourseActorGuard. */
@Injectable()
export class CourseCsrfGuard implements CanActivate {
  constructor(private readonly csrf: CsrfGuard) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { [COURSE_ACTOR_KEY]?: { kind: 'web' | 'cli' } }>();
    if (request[COURSE_ACTOR_KEY]?.kind === 'cli') return true;
    return this.csrf.canActivate(context);
  }
}
