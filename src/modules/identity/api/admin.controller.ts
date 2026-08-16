import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AccountService } from '../application/account.service';
import {
  SessionGuard,
  CsrfGuard,
  AdminGuard,
  CurrentAccount,
} from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import { CreateAccountDto } from './dto/create-account.dto';
import { AccountDto } from './dto/account.dto';

/**
 * Admin account-management endpoints under /api/v1/admin.
 *
 * Slice scope: CSRF-protected teacher/admin account creation.
 * Disable/restore, CLI credential lifecycle, and course-permission toggle remain
 * deferred.
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
    return {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      status: account.status,
      canCreateCourse: account.canCreateCourse,
      createdAt: account.createdAt.toISOString(),
    };
  }
}
