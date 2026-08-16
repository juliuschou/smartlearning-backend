import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { UnauthorizedError } from '../../../common/errors';
import { SessionGuard } from '../../../common/auth';
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

/** Accept either the anonymous participant token or the teacher Web Session. */
@Injectable()
export class ParticipantOrSessionGuard implements CanActivate {
  constructor(
    private readonly participants: ParticipantService,
    private readonly sessions: SessionGuard,
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
    return this.sessions.canActivate(context);
  }
}
