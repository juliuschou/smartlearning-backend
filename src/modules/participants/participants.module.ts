import { Module } from '@nestjs/common';
import { LiveSessionsModule } from '../live-sessions/live-sessions.module';
import { ParticipantService } from './application/participant.service';
import { ParticipantsController } from './api/participants.controller';
import {
  ParticipantOrSessionGuard,
  ParticipantTokenGuard,
} from './api/participant-token.guard';

@Module({
  imports: [LiveSessionsModule],
  controllers: [ParticipantsController],
  providers: [
    ParticipantService,
    ParticipantTokenGuard,
    ParticipantOrSessionGuard,
  ],
  exports: [
    ParticipantService,
    ParticipantTokenGuard,
    ParticipantOrSessionGuard,
  ],
})
export class ParticipantsModule {}
