import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CsrfGuard, CurrentAccount, SessionGuard } from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import {
  LiveSessionService,
  toLiveSessionDto,
  toSessionQuestionDto,
} from '../application/live-session.service';
import {
  CreateLiveSessionDto,
  type LiveSessionDto,
  type SessionQuestionDto,
} from './dto';

@ApiTags('live-sessions')
@Controller({ path: 'live-sessions', version: '1' })
export class LiveSessionsController {
  constructor(private readonly sessions: LiveSessionService) {}

  @Post()
  @UseGuards(SessionGuard, CsrfGuard)
  async create(
    @Body() dto: CreateLiveSessionDto,
    @CurrentAccount() auth: AuthContext,
  ): Promise<LiveSessionDto> {
    return toLiveSessionDto(
      await this.sessions.createSession(dto, {
        id: auth.account.id,
        role: auth.account.role,
      }),
    );
  }

  @Post(':liveSessionId/start')
  @UseGuards(SessionGuard, CsrfGuard)
  async start(
    @Param('liveSessionId', new ParseUUIDPipe()) liveSessionId: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<LiveSessionDto> {
    return toLiveSessionDto(
      await this.sessions.startSession(liveSessionId, {
        id: auth.account.id,
        role: auth.account.role,
      }),
    );
  }

  @Post(':liveSessionId/questions/:sessionQuestionId/open')
  @UseGuards(SessionGuard, CsrfGuard)
  async open(
    @Param('liveSessionId', new ParseUUIDPipe()) liveSessionId: string,
    @Param('sessionQuestionId', new ParseUUIDPipe()) sessionQuestionId: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<SessionQuestionDto> {
    return toSessionQuestionDto(
      await this.sessions.openQuestion(liveSessionId, sessionQuestionId, {
        id: auth.account.id,
        role: auth.account.role,
      }),
    );
  }

  @Post(':liveSessionId/questions/:sessionQuestionId/close')
  @UseGuards(SessionGuard, CsrfGuard)
  async close(
    @Param('liveSessionId', new ParseUUIDPipe()) liveSessionId: string,
    @Param('sessionQuestionId', new ParseUUIDPipe()) sessionQuestionId: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<SessionQuestionDto> {
    return toSessionQuestionDto(
      await this.sessions.closeQuestion(liveSessionId, sessionQuestionId, {
        id: auth.account.id,
        role: auth.account.role,
      }),
    );
  }

  @Post(':liveSessionId/close')
  @UseGuards(SessionGuard, CsrfGuard)
  async closeSession(
    @Param('liveSessionId', new ParseUUIDPipe()) liveSessionId: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<LiveSessionDto> {
    return toLiveSessionDto(
      await this.sessions.closeSession(liveSessionId, {
        id: auth.account.id,
        role: auth.account.role,
      }),
    );
  }

  @Post(':liveSessionId/cancel')
  @UseGuards(SessionGuard, CsrfGuard)
  async cancelSession(
    @Param('liveSessionId', new ParseUUIDPipe()) liveSessionId: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<LiveSessionDto> {
    return toLiveSessionDto(
      await this.sessions.cancelSession(liveSessionId, {
        id: auth.account.id,
        role: auth.account.role,
      }),
    );
  }

  @Get(':liveSessionId')
  @UseGuards(SessionGuard)
  async detail(
    @Param('liveSessionId', new ParseUUIDPipe()) liveSessionId: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<LiveSessionDto> {
    const { session, joinedCount, votedCount } =
      await this.sessions.getTeacherDetail(liveSessionId, {
        id: auth.account.id,
        role: auth.account.role,
      });
    return toLiveSessionDto(session, { joinedCount, votedCount });
  }
}
