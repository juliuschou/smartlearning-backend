import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CsrfGuard } from './csrf.guard';
import { BATCH_ACTOR_KEY } from './batch-actor.guard';

/**
 * CSRF enforcement for batch endpoints that accept either Web or CLI actors.
 * Web (cookie-authenticated) requests require CSRF double-submit; CLI
 * (credential-header) requests are exempt because their trust boundary is the
 * credential, not a browser session. Must run AFTER `BatchActorGuard`.
 */
@Injectable()
export class BatchCsrfGuard implements CanActivate {
  constructor(private readonly csrf: CsrfGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { [BATCH_ACTOR_KEY]?: { kind: 'web' | 'cli' } }>();
    const actor = request[BATCH_ACTOR_KEY];
    if (actor?.kind === 'cli') {
      return true;
    }
    return this.csrf.canActivate(context);
  }
}
