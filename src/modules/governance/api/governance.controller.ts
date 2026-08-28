import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CsrfGuard,
  CurrentAccount,
  SessionGuard,
  TeacherOrAdminGuard,
  AdminGuard,
  StepUpGuard,
} from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import { GovernanceService } from '../application/governance.service';
import {
  ArchiveListQueryDto,
  DeletionConfirmDto,
  DeletionRequestDto,
} from './dto/governance.dto';
@ApiTags('results')
@Controller({ path: 'results', version: '1' })
export class GovernanceController {
  constructor(private readonly governance: GovernanceService) {}
  @Get()
  @UseGuards(SessionGuard, TeacherOrAdminGuard)
  list(@Query() query: ArchiveListQueryDto, @CurrentAccount() a: AuthContext) {
    return this.governance.list(
      { id: a.account.id, role: a.account.role },
      query,
    );
  }
  @Get(':liveSessionId') @UseGuards(SessionGuard, TeacherOrAdminGuard) detail(
    @Param('liveSessionId', new ParseUUIDPipe()) id: string,
    @CurrentAccount() a: AuthContext,
  ) {
    return this.governance.detail(id, {
      id: a.account.id,
      role: a.account.role,
    });
  }
  @Post(':liveSessionId/deletion-requests')
  @UseGuards(SessionGuard, CsrfGuard, TeacherOrAdminGuard)
  request(
    @Param('liveSessionId', new ParseUUIDPipe()) id: string,
    @Body() dto: DeletionRequestDto,
    @CurrentAccount() a: AuthContext,
  ) {
    return this.governance.request(
      id,
      a.account.id,
      a.account.role,
      dto.reason,
    );
  }
}
@ApiTags('admin-results')
@Controller({ path: 'admin/results', version: '1' })
export class AdminGovernanceController {
  constructor(private readonly governance: GovernanceService) {}
  @Post(':liveSessionId/deletion')
  @UseGuards(SessionGuard, CsrfGuard, AdminGuard, StepUpGuard)
  delete(
    @Param('liveSessionId', new ParseUUIDPipe()) id: string,
    @Body() dto: DeletionConfirmDto,
    @CurrentAccount() a: AuthContext,
  ) {
    return this.governance.delete(id, a.account.id, dto.reason, dto.confirmed);
  }
}
