import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SESSION_COOKIE_NAME } from '../auth/auth.config';
import { AuthSessionGuard } from '../auth/auth-session.guard';
import { AuthenticatedRequest } from '../auth/auth.types';
import { CreateTeacherDto } from './create-teacher.dto';
import { CreateTeacherResponseDto } from './create-teacher.response.dto';
import { AccountsService } from './accounts.service';

@ApiTags('老師帳號管理')
@ApiCookieAuth(SESSION_COOKIE_NAME)
@Controller('teachers')
@UseGuards(AuthSessionGuard)
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBody({ type: CreateTeacherDto })
  @ApiOperation({
    summary: '建立老師正式帳號（初始狀態 INVITED，並寄送啟用邀請）',
  })
  @ApiResponse({ status: 201, type: CreateTeacherResponseDto })
  @ApiResponse({ status: 400, description: '欄位缺漏或格式不符合規則。' })
  @ApiResponse({ status: 401, description: '尚未登入或登入 Session 已失效。' })
  @ApiResponse({ status: 403, description: '不具備 M04 老師帳號建立權限。' })
  @ApiResponse({
    status: 409,
    description: 'Email 或帳號名稱與既有帳號重複（不分大小寫）。',
  })
  @ApiResponse({
    status: 503,
    description: '帳號服務暫時無法使用，重送不會重複建立。',
  })
  createTeacher(
    @Body() body: CreateTeacherDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.accountsService.createTeacher(
      body,
      request.auth.permissionSnapshot.permissionCodes,
      request.auth.userAccountId,
    );
  }
}
