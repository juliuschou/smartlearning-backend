import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { CsrfGuard, SessionGuard } from '../../../common/auth';
import { SESSION_COOKIE_NAME } from '../../../common/security';
import { AccountRole } from '../../identity/domain/roles';
import { ForbiddenError, UnauthorizedError } from '../../../common/errors';
import {
  ParticipantService,
  PARTICIPANT_TOKEN_HEADER,
} from '../application/participant.service';
import type { ParticipantRequest } from './participant-context';

@Injectable()
export class ParticipantTokenGuard implements CanActivate {
  constructor(private readonly participants: ParticipantService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ParticipantRequest>();
    const liveSessionId = request.params.liveSessionId;
    if (typeof liveSessionId !== 'string') throw new UnauthorizedError();
    const token = request.get(PARTICIPANT_TOKEN_HEADER);
    const participantContext = await this.participants.authenticate(
      liveSessionId,
      token,
    );
    request.participantContext = participantContext;
    return true;
  }
}

/**
 * Allow anonymous joins without a cookie, or require an authenticated student
 * when a Web Session cookie is present. Teacher/admin cookies cannot silently
 * enter the student participant path.
 */
@Injectable()
export class OptionalStudentSessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionGuard,
    private readonly csrf: CsrfGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ParticipantRequest>();
    const rawSession = request.cookies?.[SESSION_COOKIE_NAME];
    if (!rawSession) return true;

    await this.sessions.canActivate(context);
    if (request.authContext?.account.role !== AccountRole.STUDENT) {
      throw new ForbiddenError('Student role required for cookie join');
    }
    // Cookie-backed join is a mutation; anonymous session-code join remains
    // bearer-free and therefore keeps its pre-existing behavior.
    this.csrf.canActivate(context);
    return true;
  }
}

/**
 * Accept either the anonymous participant token or a Web Session. Student
 * sessions resolve to an account-bound participant; teacher/admin sessions
 * retain the teacher projection path.
 */
@Injectable()
export class ParticipantOrSessionGuard implements CanActivate {
  constructor(
    private readonly participants: ParticipantService,
    private readonly sessions: SessionGuard,
    private readonly csrf: CsrfGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ParticipantRequest>();
    const token = request.get(PARTICIPANT_TOKEN_HEADER);
    if (token) {
      const liveSessionId = request.params.liveSessionId;
      if (typeof liveSessionId !== 'string') throw new UnauthorizedError();
      request.participantContext = await this.participants.authenticate(
        liveSessionId,
        token,
      );
      return true;
    }

    const authenticated = await this.sessions.canActivate(context);
    // CsrfGuard is a no-op for GETs, but protects cookie-backed submission
    // mutations before participant resolution can create a row.
    this.csrf.canActivate(context);
    if (request.authContext?.account.role === AccountRole.STUDENT) {
      const liveSessionId = request.params.liveSessionId;
      if (typeof liveSessionId !== 'string') throw new UnauthorizedError();
      request.participantContext =
        await this.participants.resolveAccountParticipant(
          liveSessionId,
          request.authContext.account.id,
        );
    }
    return authenticated;
  }
}
