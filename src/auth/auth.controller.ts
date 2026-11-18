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
  ApiBody,
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
import {
  ChangeOwnPasswordDto,
  OwnProfileResponseDto,
  UpdateOwnProfileDto,
} from './account.dto';
import { AuthenticatedRequest } from './auth.types';
import {
  RequestPasswordResetDto,
  ResetPasswordDto,
} from './password-reset.dto';
import { PasswordResetService } from './password-reset.service';

type CookieRequest = Request & {
  cookies: Record<string, string | undefined>;
};

@ApiTags('登入 Session')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: AuthConfig,
    private readonly security: AuthSecurityService,
    private readonly passwordResetService: PasswordResetService,
  ) {}

  @Get('csrf')
  @ApiOperation({
    summary: '取得登入或目前登入 Session 使用的 CSRF 權杖',
  })
  @ApiResponse({
    status: 200,
    description: '已簽發雙重提交 CSRF 權杖。',
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
  @ApiOperation({ summary: '建立登入 Session' })
  @ApiHeader({
    name: CSRF_HEADER_NAME,
    required: true,
    description: '必須與 GET /auth/csrf 簽發的 CSRF Cookie 相符。',
  })
  @ApiResponse({ status: 200, description: '已建立登入 Session。' })
  @ApiResponse({
    status: 401,
    description: '登入識別或密碼驗證失敗。',
  })
  @ApiResponse({
    status: 403,
    description: '來源或 CSRF 驗證失敗。',
  })
  @ApiResponse({
    status: 503,
    description: '驗證服務目前無法使用。',
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
  @ApiOperation({ summary: '撤銷目前的登入 Session' })
  @ApiHeader({
    name: CSRF_HEADER_NAME,
    required: true,
    description: '必須與目前瀏覽器狀態所對應的 CSRF Cookie 相符。',
  })
  @ApiResponse({ status: 204, description: '已撤銷登入 Session。' })
  @ApiResponse({
    status: 403,
    description: '來源或 CSRF 驗證失敗。',
  })
  async logout(
    @Req() request: CookieRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    // 即使伺服器撤銷登入時出錯，也清掉瀏覽器保存的 cookie，避免它繼續被送出。
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
  @ApiOperation({ summary: '驗證目前的登入 Session' })
  @ApiResponse({
    status: 200,
    description: '目前的登入 Session 有效。',
    schema: { example: { authenticated: true } },
  })
  @ApiResponse({
    status: 401,
    description: '需要有效的登入 Session。',
  })
  @ApiResponse({
    status: 503,
    description: '驗證服務目前無法使用。',
  })
  validateSession(): { authenticated: true } {
    return { authenticated: true };
  }

  @Get('me')
  @UseGuards(AuthSessionGuard)
  @ApiCookieAuth('sessionCookie')
  @ApiOperation({ summary: '取得已登入使用者的個人資料' })
  @ApiResponse({ status: 200, type: OwnProfileResponseDto })
  @ApiResponse({ status: 401, description: '需要有效的登入 Session。' })
  @ApiResponse({
    status: 503,
    description: '驗證服務目前無法使用。',
  })
  getOwnProfile(
    @Req() request: AuthenticatedRequest,
  ): Promise<OwnProfileResponseDto> {
    return this.authService.getOwnProfile(request.auth.userAccountId);
  }

  @Post('me/profile')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthSessionGuard)
  @ApiCookieAuth('sessionCookie')
  @ApiOperation({ summary: '更新本人個人資料中的允許欄位' })
  @ApiHeader({ name: CSRF_HEADER_NAME, required: true })
  @ApiBody({ type: UpdateOwnProfileDto })
  @ApiResponse({ status: 200, type: OwnProfileResponseDto })
  @ApiResponse({ status: 400, description: '個人資料欄位無效。' })
  @ApiResponse({ status: 401, description: '需要有效的登入 Session。' })
  @ApiResponse({
    status: 403,
    description: '來源或 CSRF 驗證失敗。',
  })
  @ApiResponse({
    status: 503,
    description: '驗證服務目前無法使用。',
  })
  updateOwnProfile(
    @Req() request: AuthenticatedRequest,
    @Body() body: UpdateOwnProfileDto,
  ): Promise<OwnProfileResponseDto> {
    return this.authService.updateOwnProfile(request.auth.userAccountId, body);
  }

  // 對外回覆不透露帳號是否存在，避免這個入口被用來蒐集有效帳號。
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: '申請透過電子郵件取得密碼重設指示' })
  @ApiHeader({ name: CSRF_HEADER_NAME, required: true })
  @ApiBody({ type: RequestPasswordResetDto })
  @ApiResponse({
    status: 202,
    description: '已受理申請。此回應不會透露帳號是否存在或是否符合資格。',
    schema: {
      example: {
        message: '若帳號符合資格，系統將寄送密碼重設指示。',
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: '來源或 CSRF 驗證失敗。',
  })
  @ApiResponse({
    status: 503,
    description: '驗證服務目前無法使用。',
  })
  requestPasswordReset(
    @Body() body: RequestPasswordResetDto,
  ): Promise<{ message: string }> {
    return this.passwordResetService.requestPasswordReset(body.email);
  }

  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '使用一次性電子郵件連結重設密碼' })
  @ApiHeader({ name: CSRF_HEADER_NAME, required: true })
  @ApiBody({ type: ResetPasswordDto })
  @ApiResponse({
    status: 204,
    description: '密碼已重設，並已撤銷該帳號的所有登入 Session。',
  })
  @ApiResponse({ status: 400, description: 'Token 或密碼無效。' })
  @ApiResponse({
    status: 403,
    description: '來源或 CSRF 驗證失敗。',
  })
  @ApiResponse({
    status: 503,
    description: '驗證服務目前無法使用。',
  })
  async resetPassword(@Body() body: ResetPasswordDto): Promise<void> {
    await this.passwordResetService.resetPassword(body.token, body.newPassword);
  }

  @Post('password/change')
  @UseGuards(AuthSessionGuard)
  @ApiCookieAuth('sessionCookie')
  @ApiOperation({
    summary: '變更已登入使用者的密碼並撤銷所有登入 Session',
  })
  @ApiHeader({ name: CSRF_HEADER_NAME, required: true })
  @ApiBody({ type: ChangeOwnPasswordDto })
  @ApiResponse({
    status: 204,
    description: '密碼已變更，並已撤銷該帳號的所有登入 Session。',
  })
  @ApiResponse({ status: 400, description: '新密碼無效。' })
  @ApiResponse({
    status: 401,
    description: '目前密碼不正確。',
  })
  @ApiResponse({
    status: 403,
    description: '來源或 CSRF 驗證失敗。',
  })
  @ApiResponse({
    status: 503,
    description: '驗證服務目前無法使用。',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async changeOwnPassword(
    @Req() request: AuthenticatedRequest,
    @Body() body: ChangeOwnPasswordDto,
  ): Promise<void> {
    await this.authService.changeOwnPassword(
      request.auth.userAccountId,
      body.currentPassword,
      body.newPassword,
    );
  }
}
