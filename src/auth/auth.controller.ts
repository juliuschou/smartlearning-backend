import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import {
  AuthConfig,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  PREAUTH_CSRF_TTL_SECONDS,
  SESSION_COOKIE_PATH,
} from './auth.config';
import { AuthService } from './auth.service';
import { AuthSessionGuard } from './auth-session.guard';
import { AuthSecurityService } from './auth-security.service';
import { LoginDto } from './login.dto';

type CookieRequest = Request & {
  cookies: Record<string, string | undefined>;
};

@ApiTags('Login Session')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: AuthConfig,
    private readonly security: AuthSecurityService,
  ) {}

  @Get('csrf')
  @ApiOperation({
    summary: 'Issue a CSRF token for login or the current login session',
  })
  @ApiResponse({
    status: 200,
    description: 'A signed double-submit CSRF token was issued.',
    schema: { example: { csrfToken: 'issued-token' } },
  })
  getCsrfToken(
    @Req() request: CookieRequest,
    @Res({ passthrough: true }) response: Response,
  ): { csrfToken: string } {
    const sessionCredential = request.cookies?.[this.config.sessionCookieName];
    const csrfToken = this.authService.createCsrfToken(sessionCredential);
    response.cookie(CSRF_COOKIE_NAME, csrfToken, {
      ...this.security.csrfCookieOptions(
        sessionCredential ? undefined : PREAUTH_CSRF_TTL_SECONDS * 1000,
      ),
    });
    return { csrfToken };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create a login session' })
  @ApiHeader({
    name: CSRF_HEADER_NAME,
    required: true,
    description: 'Must match the CSRF cookie issued by GET /auth/csrf.',
  })
  @ApiResponse({ status: 200, description: 'Login session created.' })
  @ApiResponse({
    status: 401,
    description: 'Credentials could not be verified.',
  })
  @ApiResponse({
    status: 403,
    description: 'Origin or CSRF validation failed.',
  })
  @ApiResponse({
    status: 503,
    description: 'Authentication service unavailable.',
  })
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ authenticated: true; csrfToken: string }> {
    const result = await this.authService.login(body.email, body.password);
    response.cookie(
      this.config.sessionCookieName,
      result.sessionCredential,
      this.security.sessionCookieOptions(),
    );
    response.cookie(
      CSRF_COOKIE_NAME,
      result.csrfToken,
      this.security.csrfCookieOptions(),
    );
    return { authenticated: true, csrfToken: result.csrfToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current login session' })
  @ApiHeader({
    name: CSRF_HEADER_NAME,
    required: true,
    description:
      'Must match the CSRF cookie issued for the current browser state.',
  })
  @ApiResponse({ status: 204, description: 'The login session was revoked.' })
  @ApiResponse({
    status: 403,
    description: 'Origin or CSRF validation failed.',
  })
  async logout(
    @Req() request: CookieRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    try {
      await this.authService.logout(
        request.cookies?.[this.config.sessionCookieName],
      );
    } finally {
      const cookieOptions = {
        path: SESSION_COOKIE_PATH,
        secure: this.config.sessionCookieSecure,
        sameSite: 'lax' as const,
      };
      response.clearCookie(this.config.sessionCookieName, {
        ...cookieOptions,
        httpOnly: true,
      });
      response.clearCookie(CSRF_COOKIE_NAME, {
        ...cookieOptions,
        httpOnly: false,
      });
    }
  }

  @Get('login-session')
  @UseGuards(AuthSessionGuard)
  @ApiCookieAuth('sessionCookie')
  @ApiOperation({ summary: 'Validate the current login session' })
  @ApiResponse({
    status: 200,
    description: 'The current login session is valid.',
    schema: { example: { authenticated: true } },
  })
  @ApiResponse({
    status: 401,
    description: 'A valid login session is required.',
  })
  @ApiResponse({
    status: 503,
    description: 'Authentication service unavailable.',
  })
  validateSession(): { authenticated: true } {
    return { authenticated: true };
  }
}
