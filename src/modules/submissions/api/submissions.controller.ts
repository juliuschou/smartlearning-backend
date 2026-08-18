import {
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentParticipant } from '../../participants/api/participant-context';
import { ParticipantOrSessionGuard } from '../../participants/api/participant-token.guard';
import type { ParticipantContext } from '../../participants/application/participant.service';
import { SubmissionService } from '../application/submission.service';
import { CreateSubmissionDto, type SubmissionDto } from './dto';

@Controller({ path: 'live-sessions', version: '1' })
export class SubmissionsController {
  constructor(private readonly submissions: SubmissionService) {}

  @Post(':liveSessionId/submissions')
  @UseGuards(ParticipantOrSessionGuard)
  async create(
    @Param('liveSessionId', new ParseUUIDPipe()) liveSessionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentParticipant() participant: ParticipantContext | undefined,
    @Body() dto: CreateSubmissionDto,
  ): Promise<SubmissionDto> {
    const submission = await this.submissions.submit(
      liveSessionId,
      participant,
      idempotencyKey,
      dto,
    );
    return {
      id: submission.id,
      liveSessionId: submission.liveSessionId,
      sessionQuestionId: submission.sessionQuestionId,
      participantId: submission.participantId,
      selectedOptionRefs: submission.selectedOptionRefs,
      textAnswer: submission.textAnswer,
      submittedAt: submission.submittedAt.toISOString(),
    };
  }
}
