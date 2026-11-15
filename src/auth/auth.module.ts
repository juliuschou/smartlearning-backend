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

@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [
    AuthConfig,
    AuthRepository,
    AuthSecurityService,
    AuthService,
    AuthSessionGuard,
    { provide: APP_GUARD, useClass: CsrfGuard },
    OriginPolicyService,
  ],
  exports: [AuthService, AuthSessionGuard],
})
export class AuthModule {}
