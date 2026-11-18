import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthConfig } from './auth.config';
import { AuthService } from './auth.service';
import { AuthenticatedRequest } from './auth.types';

type CookieRequest = Request & {
  cookies: Record<string, string | undefined>;
};

@Injectable()
export class AuthSessionGuard implements CanActivate {
  constructor(
    private readonly config: AuthConfig,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CookieRequest>();
    // 只依伺服器發出的登入 cookie 確認身分，驗證通過後才把本人資料交給後續處理。
    const credential = request.cookies?.[this.config.sessionCookieName];
    if (!credential) throw this.unauthorized();

    const session = await this.authService.validateSession(credential);
    if (!session) throw this.unauthorized();

    (request as AuthenticatedRequest).auth = session;
    return true;
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'A valid login is required.',
    });
  }
}
