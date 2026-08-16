import { Module } from '@nestjs/common';
import { ParticipantsModule } from '../participants/participants.module';
import { SubmissionsController } from './api/submissions.controller';
import { SubmissionService } from './application/submission.service';

@Module({
  imports: [ParticipantsModule],
  controllers: [SubmissionsController],
  providers: [SubmissionService],
  exports: [SubmissionService],
})
export class SubmissionsModule {}
