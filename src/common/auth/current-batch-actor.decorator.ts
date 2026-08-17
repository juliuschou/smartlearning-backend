import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { BATCH_ACTOR_KEY, type BatchActorContext } from './batch-actor.guard';

/**
 * Extract the batch actor principal attached by `BatchActorGuard`. Throws if
 * used on a route not guarded by `BatchActorGuard`.
 */
export const CurrentBatchActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): BatchActorContext => {
    const request = ctx.switchToHttp().getRequest<{
      [BATCH_ACTOR_KEY]?: BatchActorContext;
    }>();
    const actor = request[BATCH_ACTOR_KEY];
    if (!actor) {
      throw new Error(
        'CurrentBatchActor used without BatchActorGuard on the route.',
      );
    }
    return actor;
  },
);
