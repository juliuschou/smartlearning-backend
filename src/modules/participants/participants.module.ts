import { Module } from '@nestjs/common';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { LiveSessionsModule } from '../live-sessions/live-sessions.module';
import { ParticipantService } from './application/participant.service';
import { ParticipantsController } from './api/participants.controller';
import {
  AuthenticatedStudentSessionGuard,
  ParticipantOrSessionGuard,
  ParticipantTokenGuard,
} from './api/participant-token.guard';

@Module({
  imports: [LiveSessionsModule, EnrollmentsModule],
  controllers: [ParticipantsController],
  providers: [
    ParticipantService,
    ParticipantTokenGuard,
    ParticipantOrSessionGuard,
    AuthenticatedStudentSessionGuard,
  ],
  exports: [
    ParticipantService,
    ParticipantTokenGuard,
    ParticipantOrSessionGuard,
    AuthenticatedStudentSessionGuard,
  ],
})
export class ParticipantsModule {}
