import { Module } from '@nestjs/common';
import { AuthController } from './api/auth.controller';
import { AdminController } from './api/admin.controller';
import { AccountService } from './application/account.service';
import { AuthService } from './application/auth.service';
import { BootstrapService } from './application/bootstrap.service';

/**
 * Identity bounded context: Web accounts, auth (login/session), admin account
 * management, and one-time bootstrap.
 *
 * AuthModule (SessionService/guards) is global, so it is not imported here.
 */
@Module({
  controllers: [AuthController, AdminController],
  providers: [AccountService, AuthService, BootstrapService],
  exports: [AccountService, AuthService, BootstrapService],
})
export class IdentityModule {}
