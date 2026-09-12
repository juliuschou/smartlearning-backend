import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  AdminGuard,
  CsrfGuard,
  CurrentAccount,
  SessionGuard,
  StepUpGuard,
  TeacherOrAdminGuard,
} from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import {
  OpenTextResponseDto,
  OpenTextResultsDto,
  OptionCountDto,
  PollResultsDto,
  QuizResultsDto,
} from '../../live-sessions/api/dto';
import { GovernanceService } from '../application/governance.service';
import {
  ActiveArchiveDetailDto,
  AdminDeletionRequestSummaryDto,
  ArchiveDeletionDto,
  ArchiveListQueryDto,
  ArchivePageDto,
  ArchiveSummaryDto,
  ArchivedQuestionDto,
  ArchivedResultPayloadDto,
  DeletedArchiveDetailDto,
  DeletionConfirmDto,
  DeletionRequestListQueryDto,
  DeletionRequestPageDto,
  DeletionRequestReceiptDto,
  DeletionRequestSummaryDto,
  DeletionRequestDto,
  DeletionResultDto,
} from './dto/governance.dto';

@ApiTags('results')
@ApiExtraModels(
  ArchivePageDto,
  ArchiveSummaryDto,
  ArchivedResultPayloadDto,
  ArchivedQuestionDto,
  OptionCountDto,
  PollResultsDto,
  QuizResultsDto,
  OpenTextResultsDto,
  OpenTextResponseDto,
  ActiveArchiveDetailDto,
  DeletedArchiveDetailDto,
  DeletionRequestSummaryDto,
  ArchiveDeletionDto,
  DeletionRequestReceiptDto,
  DeletionResultDto,
)
@Controller({ path: 'results', version: '1' })
export class GovernanceController {
  constructor(private readonly governance: GovernanceService) {}

  @Get()
  @ApiOperation({ summary: 'List archived live-session results' })
  @ApiOkResponse({ type: ArchivePageDto })
  @UseGuards(SessionGuard, TeacherOrAdminGuard)
  list(
    @Query() query: ArchiveListQueryDto,
    @CurrentAccount() account: AuthContext,
  ) {
    return this.governance.list(
      { id: account.account.id, role: account.account.role },
      query,
    );
  }

  @Get(':liveSessionId')
  @ApiOperation({ summary: 'Read an active archive or deleted tombstone' })
  @ApiParam({ name: 'liveSessionId', format: 'uuid' })
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(ActiveArchiveDetailDto) },
        { $ref: getSchemaPath(DeletedArchiveDetailDto) },
      ],
      discriminator: { propertyName: 'status' },
    },
  })
  @UseGuards(SessionGuard, TeacherOrAdminGuard)
  detail(
    @Param('liveSessionId', new ParseUUIDPipe()) id: string,
    @CurrentAccount() account: AuthContext,
  ) {
    return this.governance.detail(id, {
      id: account.account.id,
      role: account.account.role,
    });
  }

  // Layered authorization contract (BE-5.3.1): the route guard admits Teacher OR Admin, but the
  // service restricts creation to teacher role only (admins consume the request via the admin
  // confirmation path). Keep the service-level teacher-only check authoritative; do not rely on
  // this route guard alone.
  @Post(':liveSessionId/deletion-requests')
  @ApiOperation({ summary: 'Request early deletion of an owned archive' })
  @ApiParam({ name: 'liveSessionId', format: 'uuid' })
  @ApiCreatedResponse({ type: DeletionRequestReceiptDto })
  @UseGuards(SessionGuard, CsrfGuard, TeacherOrAdminGuard)
  request(
    @Param('liveSessionId', new ParseUUIDPipe()) id: string,
    @Body() dto: DeletionRequestDto,
    @CurrentAccount() account: AuthContext,
  ) {
    return this.governance.request(
      id,
      account.account.id,
      account.account.role,
      dto.reason,
    );
  }
}

@ApiTags('admin-results')
@ApiExtraModels(
  DeletionRequestPageDto,
  AdminDeletionRequestSummaryDto,
  DeletionResultDto,
)
@Controller({ path: 'admin/results', version: '1' })
export class AdminGovernanceController {
  constructor(private readonly governance: GovernanceService) {}

  @Get('deletion-requests')
  @ApiOperation({ summary: 'List pending archive deletion requests' })
  @ApiOkResponse({ type: DeletionRequestPageDto })
  @UseGuards(SessionGuard, AdminGuard)
  listDeletionRequests(@Query() query: DeletionRequestListQueryDto) {
    return this.governance.listDeletionRequests(query);
  }

  @Post(':liveSessionId/deletion')
  @ApiOperation({ summary: 'Confirm a specific archive deletion request' })
  @ApiParam({ name: 'liveSessionId', format: 'uuid' })
  @ApiCreatedResponse({ type: DeletionResultDto })
  @UseGuards(SessionGuard, CsrfGuard, AdminGuard, StepUpGuard)
  delete(
    @Param('liveSessionId', new ParseUUIDPipe()) id: string,
    @Body() dto: DeletionConfirmDto,
    @CurrentAccount() account: AuthContext,
  ) {
    return this.governance.delete(
      id,
      account.account.id,
      dto.deletionRequestId,
      dto.reason,
    );
  }
}
