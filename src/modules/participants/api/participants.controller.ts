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
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AccountRole } from '../../identity/domain/roles';
import { UnauthorizedError } from '../../../common/errors';
import { JoinLiveSessionDto, JoinLiveSessionResponseDto } from './dto';
import type {
  LiveSessionDto,
  SessionQuestionResultsDto,
} from '../../live-sessions/api/dto';
import { StudentLiveSessionStatusDto } from '../../live-sessions/api/dto';
import { SessionQuestionStatus } from '../../live-sessions/domain';
import { ParticipantService } from '../application/participant.service';
import {
  CurrentParticipant,
  type ParticipantRequest,
} from './participant-context';
import {
  AuthenticatedStudentSessionGuard,
  OptionalStudentSessionGuard,
  ParticipantOrSessionGuard,
} from './participant-token.guard';
import { CurrentAccount } from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
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
  @UseGuards(OptionalStudentSessionGuard)
  async join(
    @Param('sessionCode') sessionCode: string,
    @Body() dto: JoinLiveSessionDto,
    @Req() request: ParticipantRequest,
  ): Promise<JoinLiveSessionResponseDto> {
    const result =
      request.authContext?.account.role === AccountRole.STUDENT
        ? await this.participants.joinForAccount(
            sessionCode,
            request.authContext.account.id,
          )
        : await this.participants.join(sessionCode, dto.displayName);
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
      const snapshot = await this.sessions.getTeacherRealtimeSnapshot(
        liveSessionId,
        {
          id: request.authContext!.account.id,
          role: request.authContext!.account.role,
        },
      );
      return {
        ...toLiveSessionDto(snapshot.session, {
          joinedCount: snapshot.joinedCount,
          votedCount: snapshot.votedCount,
        }),
        watermark: snapshot.watermark,
        results: snapshot.results,
      };
    }

    const participantView = await this.sessions.getParticipantSnapshot(
      liveSessionId,
      participant.participantId,
      participant.accountId,
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
      watermark: participantView.watermark,
      results: participantView.results,
    };
  }

  /**
   * Results/aggregate for a single SessionQuestion (S-3).
   *
   * Teacher (Web session cookie) sees the anonymous aggregate at any time.
   * Anonymous token participants and enrolled student cookie participants see
   * it only after submission while open, or after question close.
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
          accountId: participant.accountId,
        } as const)
      : ({
          kind: 'teacher',
          accountId: request.authContext!.account.id,
          role: request.authContext!.account.role,
        } as const);
    return this.sessions.getResults(liveSessionId, sessionQuestionId, actor);
  }

  /**
   * Student-only lifecycle receipt (FE-4.1). Unlike the polymorphic snapshot,
   * this route accepts only an active student Web Session with an active
   * enrollment, ignores X-Participant-Token entirely, and never resolves or
   * creates a Participant. All four lifecycle states return 200.
   */
  @Get(':liveSessionId/student-status')
  @ApiOperation({
    summary:
      'Read the lifecycle status of a live session as an enrolled student',
  })
  @ApiParam({ name: 'liveSessionId', format: 'uuid' })
  @ApiResponse({ status: 200, type: StudentLiveSessionStatusDto })
  @UseGuards(AuthenticatedStudentSessionGuard)
  async studentStatus(
    @Param('liveSessionId', new ParseUUIDPipe()) liveSessionId: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<StudentLiveSessionStatusDto> {
    const status = await this.sessions.getStudentLiveSessionStatus(
      liveSessionId,
      auth.account.id,
    );
    return {
      id: status.id,
      status: status.status,
      startedAt: status.startedAt ? status.startedAt.toISOString() : null,
      closedAt: status.closedAt ? status.closedAt.toISOString() : null,
    };
  }
}
