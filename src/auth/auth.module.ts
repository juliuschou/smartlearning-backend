import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from '../database/prisma.module';
import { AuthController } from './auth.controller';
import { AuthConfig } from './auth.config';
import { AuthRepository } from './auth.repository';
import { AuthSecurityService } from './auth-security.service';
import { AuthService } from './auth.service';
import { AuthSessionGuard } from './auth-session.guard';
import { CsrfGuard } from './csrf.guard';
import { OriginPolicyService } from './origin-policy.service';
import { PasswordResetRepository } from './password-reset.repository';
import { PasswordResetService } from './password-reset.service';
import { ResetMailService } from './reset-mail.service';
import { EmailOutboxProcessor } from './email-outbox.processor';

@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [
    AuthConfig,
    AuthRepository,
    AuthSecurityService,
    AuthService,
    AuthSessionGuard,
    // 所有會改變資料的入口先經過這道檢查，避免端點漏設保護。
    { provide: APP_GUARD, useClass: CsrfGuard },
    OriginPolicyService,
    PasswordResetRepository,
    PasswordResetService,
    ResetMailService,
    EmailOutboxProcessor,
  ],
  exports: [
    AuthConfig,
    AuthService,
    AuthSessionGuard,
    AuthRepository,
    AuthSecurityService,
    ResetMailService,
  ],
})
export class AuthModule {}
