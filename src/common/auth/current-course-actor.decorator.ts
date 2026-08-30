import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import {
  COURSE_ACTOR_KEY,
  type CourseActorContext,
} from './course-actor.guard';

export const CurrentCourseActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CourseActorContext => {
    const request = context.switchToHttp().getRequest<{
      [COURSE_ACTOR_KEY]?: CourseActorContext;
    }>();
    const actor = request[COURSE_ACTOR_KEY];
    if (!actor) {
      throw new Error(
        'CurrentCourseActor used without CourseActorGuard on the route.',
      );
    }
    return actor;
  },
);
