import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenError } from '../errors';
import type { AuthContext } from './auth-context';
import { SessionService } from './session.service';

/**
 * Requires a recent server-side password step-up for the current account and
 * WebSession. Compose after SessionGuard.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { authContext?: AuthContext }>();
    const auth = req.authContext;
    if (!auth) {
      throw new ForbiddenError();
    }
    await this.sessions.assertRecentStepUp(auth.account.id, auth.sessionId);
    return true;
  }
}
