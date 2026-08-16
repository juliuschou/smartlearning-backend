import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '../../../common/auth';
import type { ParticipantContext } from '../application/participant.service';

export type ParticipantRequest = Request & {
  participantContext?: ParticipantContext;
  authContext?: AuthContext;
};

export const CurrentParticipant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ParticipantContext | undefined => {
    const request = ctx.switchToHttp().getRequest<ParticipantRequest>();
    return request.participantContext;
  },
);
