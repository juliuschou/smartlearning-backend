import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { UnauthorizedError } from '../../../common/errors';
import { JoinLiveSessionDto, JoinLiveSessionResponseDto } from './dto';
import type {
  LiveSessionDto,
  SessionQuestionResultsDto,
} from '../../live-sessions/api/dto';
import { SessionQuestionStatus } from '../../live-sessions/domain';
import { ParticipantService } from '../application/participant.service';
import {
  CurrentParticipant,
  type ParticipantRequest,
} from './participant-context';
import { ParticipantOrSessionGuard } from './participant-token.guard';
import type { ParticipantContext } from '../application/participant.service';
import {
  LiveSessionService,
  toLiveSessionDto,
} from '../../live-sessions/application/live-session.service';

@ApiTags('live-sessions')
@Controller({ path: 'live-sessions', version: '1' })
export class ParticipantsController {
  constructor(
    private readonly participants: ParticipantService,
    private readonly sessions: LiveSessionService,
  ) {}

  @Post(':sessionCode/join')
  async join(
    @Param('sessionCode') sessionCode: string,
    @Body() dto: JoinLiveSessionDto,
  ): Promise<JoinLiveSessionResponseDto> {
    const result = await this.participants.join(sessionCode, dto.displayName);
    const currentQuestion =
      result.liveSession.sessionQuestions?.find(
        (question) => question.status === SessionQuestionStatus.OPEN,
      ) ?? null;
    return {
      participantId: result.participant.id,
      participantToken: result.participantToken,
      liveSession: {
        id: result.liveSession.id,
        status: result.liveSession.status,
        sessionCode: result.liveSession.sessionCode,
      },
      currentQuestion,
    };
  }

  @Get(':liveSessionId/snapshot')
  @UseGuards(ParticipantOrSessionGuard)
  async snapshot(
    @Param('liveSessionId', new ParseUUIDPipe()) liveSessionId: string,
    @CurrentParticipant() participant: ParticipantContext | undefined,
    @Req() request: ParticipantRequest,
  ): Promise<LiveSessionDto> {
    if (!participant && !request.authContext) throw new UnauthorizedError();
    if (!participant) {
      return toLiveSessionDto(
        await this.sessions.getSnapshot(liveSessionId, {
          id: request.authContext!.account.id,
          role: request.authContext!.account.role,
        }),
      );
    }

    const participantView = await this.sessions.getParticipantSnapshot(
      liveSessionId,
      participant.participantId,
    );
    const snapshot = toLiveSessionDto(participantView.session);
    const {
      questionSelections: _questionSelections,
      sessionQuestions,
      ...participantSnapshot
    } = snapshot;
    return {
      ...participantSnapshot,
      sessionQuestions: (sessionQuestions ?? [])
        .filter((question) => question.status === SessionQuestionStatus.OPEN)
        .map((question) => ({
          ...question,
          hasSubmitted: participantView.submittedQuestionIds.has(question.id),
        })),
    };
  }

  /**
   * Results/aggregate for a single SessionQuestion (S-3).
   *
   * Teacher (Web session cookie) sees the anonymous aggregate at any time.
   * Participant (X-Participant-Token) sees it only after they have submitted
   * (while the question is open) or after the question is closed (vote-to-reveal,
   * US-F17). Aggregation is derived on-the-fly from committed Submission rows.
   */
  @Get(':liveSessionId/questions/:sessionQuestionId/results')
  @UseGuards(ParticipantOrSessionGuard)
  async results(
    @Param('liveSessionId', new ParseUUIDPipe()) liveSessionId: string,
    @Param('sessionQuestionId', new ParseUUIDPipe())
    sessionQuestionId: string,
    @CurrentParticipant() participant: ParticipantContext | undefined,
    @Req() request: ParticipantRequest,
  ): Promise<SessionQuestionResultsDto> {
    if (!participant && !request.authContext) throw new UnauthorizedError();
    const actor = participant
      ? ({
          kind: 'participant',
          participantId: participant.participantId,
        } as const)
      : ({
          kind: 'teacher',
          accountId: request.authContext!.account.id,
          role: request.authContext!.account.role,
        } as const);
    return this.sessions.getResults(liveSessionId, sessionQuestionId, actor);
  }
}
