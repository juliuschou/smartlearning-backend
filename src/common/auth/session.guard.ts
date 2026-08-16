import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { SESSION_COOKIE_NAME } from '../security';
import { UnauthorizedError } from '../errors';
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
  constructor(private readonly sessions: SessionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { authContext?: AuthContext }>();
    const raw = req.cookies?.[SESSION_COOKIE_NAME];
    if (!raw || typeof raw !== 'string') {
      throw new UnauthorizedError();
    }
    const { session, account } = await this.sessions.loadActiveSession(raw);
    req.authContext = {
      account: {
        id: account.id,
        username: account.username,
        displayName: account.displayName,
        role: account.role,
        status: account.status,
        canCreateCourse: account.canCreateCourse,
      },
      sessionId: session.id,
    };
    return true;
  }
}
