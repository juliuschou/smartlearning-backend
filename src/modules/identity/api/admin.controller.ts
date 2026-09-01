import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExtraModels, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ValidationError } from '../../../common/errors';
import {
  AdminGuard,
  CsrfGuard,
  CurrentAccount,
  SessionGuard,
  StepUpGuard,
} from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import { type Page } from '../../../common/pagination';
import { AccountService } from '../application/account.service';
import { CliCredentialService } from '../application/cli-credential.service';
import { AccountDto } from './dto/account.dto';
import { CreateAccountDto } from './dto/create-account.dto';
import { RequirePasswordChangeDto } from './dto/require-password-change.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { UpdateAccountPermissionsDto } from './dto/update-account-permissions.dto';
import {
  CreateCliCredentialDto,
  CliCredentialDto,
  CreateCliCredentialResponseDto,
  RotateCliCredentialResponseDto,
} from './dto/cli-credential.dto';

/**
 * Admin account-management endpoints under /api/v1/admin.
 *
 * All mutations require an active admin session and CSRF/Origin validation;
 * sensitive account lifecycle operations additionally require step-up.
 * CLI key create/revoke are high-risk and require step-up (M2 紅卡).
 */
@ApiTags('admin')
@ApiExtraModels(
  CliCredentialDto,
  CreateCliCredentialResponseDto,
  RotateCliCredentialResponseDto,
)
@Controller({ path: 'admin', version: '1' })
@UseGuards(SessionGuard, CsrfGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly accounts: AccountService,
    private readonly cliCredentials: CliCredentialService,
  ) {}

  @Get('accounts')
  async listAccounts(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Page<AccountDto>> {
    const result = await this.accounts.listAccounts({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
    return { data: result.data.map(toAccountDto), meta: result.meta };
  }

  @Get('accounts/:id')
  async getAccount(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AccountDto> {
    return toAccountDto(await this.accounts.getAccountById(id));
  }

  @Patch('accounts/:id/permissions')
  async updateAccountPermissions(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAccountPermissionsDto,
  ): Promise<AccountDto> {
    return toAccountDto(
      await this.accounts.updateCourseCreationPermission(
        id,
        dto.canCreateCourse,
      ),
    );
  }

  /**
   * Admin account profile update (BE-8.2 CP2). Frozen allowlist:
   * `displayName` / `role` / `canCreateCourse`, all optional, at least one
   * present. Promotion to admin is step-up-checked in the service (not via
   * method-level StepUpGuard, which would also gate displayName updates).
   * Self role change is rejected in the service. No session/CLI/token
   * revocation — lifecycle side effects stay on their dedicated endpoints.
   */
  @Patch('accounts/:id')
  async updateAccount(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAccountDto,
    @CurrentAccount() auth: AuthContext,
  ): Promise<AccountDto> {
    if (
      dto.displayName === undefined &&
      dto.role === undefined &&
      dto.canCreateCourse === undefined
    ) {
      throw new ValidationError(
        'At least one of displayName, role, or canCreateCourse is required',
      );
    }
    const account = await this.accounts.updateAccount(id, auth, {
      displayName: dto.displayName,
      role: dto.role,
      canCreateCourse: dto.canCreateCourse,
    });
    return toAccountDto(account);
  }

  @Post('accounts')
  async createAccount(
    @Body() dto: CreateAccountDto,
    @CurrentAccount() auth: AuthContext,
  ): Promise<AccountDto> {
    const account = await this.accounts.createAccount({
      username: dto.username,
      displayName: dto.displayName,
      role: dto.role,
      canCreateCourse: dto.canCreateCourse,
      tempPassword: dto.tempPassword,
      createdBy: auth.account.id,
    });
    return toAccountDto(account);
  }

  @Post('accounts/:id/reset-password')
  @UseGuards(StepUpGuard)
  async resetPassword(
    @Param('id') id: string,
    @Body() dto: ResetPasswordDto,
    @CurrentAccount() auth: AuthContext,
  ): Promise<AccountDto> {
    const account = await this.accounts.resetPassword(
      id,
      dto.tempPassword,
      auth.account.id,
    );
    return toAccountDto(account);
  }

  @Post('accounts/:id/disable')
  @UseGuards(StepUpGuard)
  async disable(
    @Param('id') id: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<AccountDto> {
    const account = await this.accounts.disableAccount(id, auth.account.id);
    return toAccountDto(account);
  }

  @Post('accounts/:id/restore')
  @UseGuards(StepUpGuard)
  async restore(
    @Param('id') id: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<AccountDto> {
    const account = await this.accounts.restoreAccount(id, auth.account.id);
    return toAccountDto(account);
  }

  /**
   * Admin forces/clears the `mustChangePassword` gate (BE-8.2 CP2, plan §1.3).
   * Step-up protected like the other lifecycle operations. Self-target is
   * allowed (an admin clearing their own flag is legitimate self-service).
   */
  @Post('accounts/:id/require-password-change')
  @UseGuards(StepUpGuard)
  async requirePasswordChange(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RequirePasswordChangeDto,
  ): Promise<AccountDto> {
    const account = await this.accounts.setMustChangePassword(
      id,
      dto.mustChangePassword,
    );
    return toAccountDto(account);
  }

  @Post('accounts/:id/cli-credentials')
  @ApiResponse({ status: 201, type: CreateCliCredentialResponseDto })
  @UseGuards(StepUpGuard)
  async createCliCredential(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateCliCredentialDto,
  ): Promise<CreateCliCredentialResponseDto> {
    const { credential, rawKey } = await this.cliCredentials.createCredential(
      id,
      dto.name,
    );
    return { ...toCliCredentialDto(credential), rawKey };
  }

  @Get('accounts/:id/cli-credentials')
  async listCliCredentials(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CliCredentialDto[]> {
    const credentials = await this.cliCredentials.listCredentials(id);
    return credentials.map((c) => toCliCredentialDto(c));
  }

  @Post('accounts/:id/cli-credentials/:credentialId/rotate')
  @ApiResponse({ status: 201, type: RotateCliCredentialResponseDto })
  @UseGuards(StepUpGuard)
  async rotateCliCredential(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
  ): Promise<RotateCliCredentialResponseDto> {
    const { credential, rawKey } = await this.cliCredentials.rotateCredential(
      id,
      credentialId,
    );
    return { ...toCliCredentialDto(credential), rawKey };
  }

  @Post('accounts/:id/cli-credentials/:credentialId/revoke')
  @UseGuards(StepUpGuard)
  @HttpCode(200)
  async revokeCliCredential(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
  ): Promise<null> {
    await this.cliCredentials.revokeCredential(id, credentialId);
    return null;
  }
}

function toCliCredentialDto(credential: {
  id: string;
  accountId: string;
  name: string;
  scope: string;
  status: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
  rotatedFromId: string | null;
}): CliCredentialDto {
  return {
    id: credential.id,
    accountId: credential.accountId,
    name: credential.name,
    scope: credential.scope,
    status: credential.status,
    lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
    createdAt: credential.createdAt.toISOString(),
    revokedAt: credential.revokedAt?.toISOString() ?? null,
    rotatedFromId: credential.rotatedFromId,
  };
}

function toAccountDto(account: {
  id: string;
  username: string;
  displayName: string;
  role: string;
  status: string;
  canCreateCourse: boolean;
  mustChangePassword: boolean;
  disabledAt: Date | null;
  createdAt: Date;
}): AccountDto {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    status: account.status,
    canCreateCourse: account.canCreateCourse,
    mustChangePassword: account.mustChangePassword,
    disabledAt: account.disabledAt?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
  };
}
