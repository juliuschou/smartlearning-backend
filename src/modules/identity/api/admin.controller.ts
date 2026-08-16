import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import {
  AdminGuard,
  CsrfGuard,
  CurrentAccount,
  SessionGuard,
  StepUpGuard,
} from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import { AccountService } from '../application/account.service';
import { AccountDto } from './dto/account.dto';
import { CreateAccountDto } from './dto/create-account.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

/**
 * Admin account-management endpoints under /api/v1/admin.
 *
 * All mutations require an active admin session and CSRF/Origin validation;
 * sensitive account lifecycle operations additionally require step-up.
 */
@Controller({ path: 'admin', version: '1' })
@UseGuards(SessionGuard, CsrfGuard, AdminGuard)
export class AdminController {
  constructor(private readonly accounts: AccountService) {}

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
