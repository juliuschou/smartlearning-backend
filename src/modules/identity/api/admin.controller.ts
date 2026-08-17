import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AdminGuard,
  CsrfGuard,
  CurrentAccount,
  SessionGuard,
  StepUpGuard,
} from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import { AccountService } from '../application/account.service';
import { CliCredentialService } from '../application/cli-credential.service';
import { AccountDto } from './dto/account.dto';
import { CreateAccountDto } from './dto/create-account.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import {
  CreateCliCredentialDto,
  CliCredentialDto,
  CreateCliCredentialResponseDto,
} from './dto/cli-credential.dto';

/**
 * Admin account-management endpoints under /api/v1/admin.
 *
 * All mutations require an active admin session and CSRF/Origin validation;
 * sensitive account lifecycle operations additionally require step-up.
 * CLI key create/revoke are high-risk and require step-up (M2 紅卡).
 */
@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
@UseGuards(SessionGuard, CsrfGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly accounts: AccountService,
    private readonly cliCredentials: CliCredentialService,
  ) {}

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

  @Post('accounts/:id/cli-credentials')
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
