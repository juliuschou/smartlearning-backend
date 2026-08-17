import { Module } from '@nestjs/common';
import { AuthController } from './api/auth.controller';
import { AdminController } from './api/admin.controller';
import { AccountService } from './application/account.service';
import { AuthService } from './application/auth.service';
import { BootstrapService } from './application/bootstrap.service';
import { CliCredentialService } from './application/cli-credential.service';
import { CliAuthGuard } from './api/cli-auth.guard';

/**
 * Identity bounded context: Web accounts, auth (login/session), admin account
 * management, CLI credentials, and one-time bootstrap.
 *
 * AuthModule (SessionService/guards) is global, so it is not imported here.
 * CliAuthGuard depends on CliCredentialService and is therefore owned here
 * (not in the global AuthModule) and exported for feature modules (e.g.
 * question batches) to apply via `@UseGuards()`.
 */
@Module({
  controllers: [AuthController, AdminController],
  providers: [
    AccountService,
    AuthService,
    BootstrapService,
    CliCredentialService,
    CliAuthGuard,
  ],
  exports: [
    AccountService,
    AuthService,
    BootstrapService,
    CliCredentialService,
    CliAuthGuard,
  ],
})
export class IdentityModule {}
