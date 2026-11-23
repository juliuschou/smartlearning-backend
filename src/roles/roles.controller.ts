import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  MethodNotAllowedException,
  Param,
  Patch,
  Put,
  Delete,
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
import {
  RoleDetailResponseDto,
  RoleResponseDto,
  UpdateRoleStatusDto,
} from './role.dto';
import { RoleService } from './role.service';

@ApiTags('角色管理')
@ApiCookieAuth(SESSION_COOKIE_NAME)
@Controller('roles')
@UseGuards(AuthSessionGuard)
export class RolesController {
  constructor(private readonly roleService: RoleService) {}

  @Get()
  @ApiOperation({ summary: '查詢 V1 固定角色清單' })
  @ApiResponse({ status: 200, type: RoleResponseDto, isArray: true })
  @ApiResponse({ status: 401, description: '尚未登入或登入 Session 已失效。' })
  @ApiResponse({ status: 403, description: '不具備 M04 角色檢視權限。' })
  @ApiResponse({ status: 503, description: '角色資料服務暫時無法使用。' })
  list(@Req() request: AuthenticatedRequest) {
    return this.roleService.list(
      request.auth.permissionSnapshot.permissionCodes,
    );
  }

  @Get(':roleCode')
  @ApiOperation({ summary: '查詢角色明細與目前功能授權摘要' })
  @ApiResponse({ status: 200, type: RoleDetailResponseDto })
  @ApiResponse({ status: 401, description: '尚未登入或登入 Session 已失效。' })
  @ApiResponse({ status: 403, description: '不具備 M04 角色檢視權限。' })
  @ApiResponse({ status: 404, description: '角色不存在。' })
  @ApiResponse({
    status: 503,
    description: '角色或功能授權資料服務暫時無法使用。',
  })
  detail(
    @Param('roleCode') roleCode: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.roleService.get(
      roleCode,
      request.auth.permissionSnapshot.permissionCodes,
    );
  }

  @Put(':roleCode')
  @HttpCode(HttpStatus.METHOD_NOT_ALLOWED)
  @ApiOperation({ summary: '固定系統角色基本資料於 V1 不可修改' })
  @ApiResponse({ status: 405, description: '角色代碼、名稱及描述為唯讀欄位。' })
  updateMetadata(): never {
    throw new MethodNotAllowedException({
      code: 'SYSTEM_ROLE_METADATA_IMMUTABLE',
      message: 'System role code, name, and description cannot be changed.',
    });
  }

  @Delete(':roleCode')
  @HttpCode(HttpStatus.METHOD_NOT_ALLOWED)
  @ApiOperation({ summary: '固定系統角色不可刪除' })
  @ApiResponse({ status: 405, description: 'V1 固定系統角色不可刪除。' })
  deleteRole(): never {
    throw new MethodNotAllowedException({
      code: 'SYSTEM_ROLE_CANNOT_BE_DELETED',
      message: 'System roles cannot be deleted.',
    });
  }

  @Patch(':roleCode/status')
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: UpdateRoleStatusDto })
  @ApiOperation({ summary: '啟用或停用固定系統角色' })
  @ApiResponse({
    status: 200,
    schema: { example: { roleCode: 'TEACHER', status: 'DISABLED' } },
  })
  @ApiResponse({ status: 400, description: '角色狀態格式不正確。' })
  @ApiResponse({ status: 401, description: '尚未登入或登入 Session 已失效。' })
  @ApiResponse({ status: 403, description: '不具備 M04 角色狀態維護權限。' })
  @ApiResponse({ status: 404, description: '角色不存在。' })
  @ApiResponse({
    status: 409,
    description: '停用會違反有效角色或最後有效系統管理者規則。',
  })
  @ApiResponse({
    status: 503,
    description: '角色服務暫時無法使用，請稍後重試。',
  })
  setStatus(
    @Param('roleCode') roleCode: string,
    @Body() body: UpdateRoleStatusDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.roleService.setStatus(
      roleCode,
      body.status,
      request.auth.permissionSnapshot.permissionCodes,
    );
  }
}
