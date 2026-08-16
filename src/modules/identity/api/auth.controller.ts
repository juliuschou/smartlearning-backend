import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import {
  AllowPasswordChangeRequired,
  CsrfGuard,
  CurrentAccount,
  SessionGuard,
  stepUpExpiresAt,
} from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  csrfCookieOptions,
  generateCsrfToken,
  sessionCookieOptions,
} from '../../../common/security';
import { AuthService } from '../application/auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { SessionDto } from './dto/account.dto';
import { StepUpDto } from './dto/step-up.dto';

/**
 * Auth endpoints under /api/v1/auth.
 *
 * Slice scope: login, current session, step-up, password change, and logout.
 */
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    const { token, session, account } = await this.auth.login(
      dto.username,
      dto.password,
      { ipAddress: req.ip, userAgent: req.get('user-agent') },
    );
    this.setSessionCookies(res, token, session.expiresAt);
    return this.sessionDto(account, session.id, session.expiresAt);
  }

  @Post('step-up')
  @AllowPasswordChangeRequired()
  @UseGuards(SessionGuard, CsrfGuard)
  async stepUp(
    @Body() dto: StepUpDto,
    @CurrentAccount() auth: AuthContext,
  ): Promise<{ expiresAt: string }> {
    const markedAt = await this.auth.stepUp(
      auth.account.id,
      auth.sessionId,
      dto.password,
    );
    return { expiresAt: stepUpExpiresAt(markedAt).toISOString() };
  }

  @Post('change-password')
  @AllowPasswordChangeRequired()
  @UseGuards(SessionGuard, CsrfGuard)
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentAccount() auth: AuthContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    const { token, session, account } = await this.auth.changePassword({
      accountId: auth.account.id,
      sessionId: auth.sessionId,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
      sessionMeta: { ipAddress: req.ip, userAgent: req.get('user-agent') },
    });
    this.setSessionCookies(res, token, session.expiresAt);
    return this.sessionDto(account, session.id, session.expiresAt);
  }

  @Post('logout')
  @AllowPasswordChangeRequired()
  @UseGuards(SessionGuard, CsrfGuard)
  async logout(
    @CurrentAccount() auth: AuthContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<null> {
    await this.auth.logout(auth.sessionId);
    const secure = this.secureCookie();
    res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions(0, secure));
    res.clearCookie(CSRF_COOKIE_NAME, csrfCookieOptions(0, secure));
    return null;
  }

  @Get('session')
  @AllowPasswordChangeRequired()
  @UseGuards(SessionGuard)
  current(@CurrentAccount() auth: AuthContext): SessionDto {
    return {
      accountId: auth.account.id,
      username: auth.account.username,
      displayName: auth.account.displayName,
      role: auth.account.role,
      canCreateCourse: auth.account.canCreateCourse,
      mustChangePassword: auth.account.mustChangePassword,
      sessionId: auth.sessionId,
      // Absolute expiry is not carried on AuthContext to avoid a per-request
      // DB read; clients rely on the login response for the absolute deadline.
      expiresAt: '',
    };
  }

  private sessionDto(
    account: {
      id: string;
      username: string;
      displayName: string;
      role: string;
      canCreateCourse: boolean;
      mustChangePassword: boolean;
    },
    sessionId: string,
    expiresAt: Date,
  ): SessionDto {
    return {
      accountId: account.id,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      canCreateCourse: account.canCreateCourse,
      mustChangePassword: account.mustChangePassword,
      sessionId,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private setSessionCookies(
    res: Response,
    token: string,
    expiresAt: Date,
  ): void {
    const secure = this.secureCookie();
    const maxAgeMs = expiresAt.getTime() - Date.now();
    res.cookie(
      SESSION_COOKIE_NAME,
      token,
      sessionCookieOptions(maxAgeMs, secure),
    );
    res.cookie(
      CSRF_COOKIE_NAME,
      generateCsrfToken(),
      csrfCookieOptions(maxAgeMs, secure),
    );
  }

  private secureCookie(): boolean {
    // Default true (__Host- requires Secure). Test apps use plain HTTP, so
    // they default to false unless explicitly configured.
    const configured = this.config.get<boolean>('SESSION_COOKIE_SECURE');
    return configured ?? this.config.get<string>('NODE_ENV') !== 'test';
  }
}
