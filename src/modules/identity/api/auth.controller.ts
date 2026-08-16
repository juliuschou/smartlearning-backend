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
import { AuthService } from '../application/auth.service';
import { SessionGuard, CsrfGuard, CurrentAccount } from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  csrfCookieOptions,
  generateCsrfToken,
  sessionCookieOptions,
} from '../../../common/security';
import { LoginDto } from './dto/login.dto';
import { SessionDto } from './dto/account.dto';

/**
 * Auth endpoints under /api/v1/auth.
 *
 * Slice scope: login, current session lookup, and CSRF-protected logout.
 * Rate limiting, password lifecycle, and step-up remain deferred.
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
      { userAgent: req.get('user-agent') },
    );
    const secure = this.secureCookie();
    const maxAgeMs = session.expiresAt.getTime() - Date.now();
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
    return {
      accountId: account.id,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      canCreateCourse: account.canCreateCourse,
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  @Post('logout')
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
  @UseGuards(SessionGuard)
  current(@CurrentAccount() auth: AuthContext): SessionDto {
    return {
      accountId: auth.account.id,
      username: auth.account.username,
      displayName: auth.account.displayName,
      role: auth.account.role,
      canCreateCourse: auth.account.canCreateCourse,
      sessionId: auth.sessionId,
      // Absolute expiry is not carried on AuthContext to avoid a per-request
      // DB read; clients rely on the login response for the absolute deadline.
      expiresAt: '',
    };
  }

  private secureCookie(): boolean {
    // Default true (__Host- requires Secure). Test apps use plain HTTP, so
    // they default to false unless explicitly configured.
    const configured = this.config.get<boolean>('SESSION_COOKIE_SECURE');
    return configured ?? this.config.get<string>('NODE_ENV') !== 'test';
  }
}
