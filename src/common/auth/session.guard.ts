import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SESSION_COOKIE_NAME } from '../security';
import { PasswordChangeRequiredError, UnauthorizedError } from '../errors';
import { ALLOW_PASSWORD_CHANGE_REQUIRED } from './password-change-required.decorator';
import { SessionService } from './session.service';
import type { AuthContext } from './auth-context';

/**
 * Reads the __Host-session cookie, resolves it to an active session+account
 * via SessionService, and attaches a minimal AuthContext to the request.
 * Rejects (401 UnauthorizedError) when there is no cookie, no session, or the
 * session/account is invalid.
 *
 * Optional role/permission gating is layered as separate guards (AdminGuard,
 * CanCreateCourseGuard) so handlers compose them declaratively.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    return this.activate(ctx, false);
  }

  /**
   * Participant routes may disclose the disabled state of an already-issued
   * cookie without changing the generic SessionGuard contract used elsewhere.
   */
  async canActivateForParticipant(ctx: ExecutionContext): Promise<boolean> {
    return this.activate(ctx, true);
  }

  private async activate(
    ctx: ExecutionContext,
    exposeDisabled: boolean,
  ): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { authContext?: AuthContext }>();
    const raw = req.cookies?.[SESSION_COOKIE_NAME];
    if (!raw || typeof raw !== 'string') {
      throw new UnauthorizedError();
    }
    const { session, account } = await this.sessions.loadActiveSession(raw, {
      exposeDisabled,
    });
    const allowPasswordChangeRequired =
      this.reflector.getAllAndOverride<boolean>(
        ALLOW_PASSWORD_CHANGE_REQUIRED,
        [ctx.getHandler(), ctx.getClass()],
      ) ?? false;
    if (account.mustChangePassword && !allowPasswordChangeRequired) {
      throw new PasswordChangeRequiredError();
    }
    req.authContext = {
      account: {
        id: account.id,
        username: account.username,
        displayName: account.displayName,
        role: account.role,
        status: account.status,
        canCreateCourse: account.canCreateCourse,
        mustChangePassword: account.mustChangePassword,
      },
      sessionId: session.id,
      sessionExpiresAt: session.expiresAt.toISOString(),
    };
    return true;
  }
}
