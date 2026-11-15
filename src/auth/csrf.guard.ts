import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import {
  AuthConfig,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  PREAUTH_CSRF_TTL_SECONDS,
  SESSION_ABSOLUTE_MS,
} from './auth.config';
import { AuthSecurityService } from './auth-security.service';
import { OriginPolicyService } from './origin-policy.service';

type CookieRequest = Request & {
  cookies: Record<string, string | undefined>;
};

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly config: AuthConfig,
    private readonly security: AuthSecurityService,
    private readonly originPolicy: OriginPolicyService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<CookieRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
      return true;
    }
    this.originPolicy.assertAllowed(request.get('origin'));

    const cookieToken = request.cookies?.[CSRF_COOKIE_NAME];
    const headerValue = request.get(CSRF_HEADER_NAME);
    const sessionCredential = request.cookies?.[this.config.sessionCookieName];
    const subject = sessionCredential
      ? this.security.hashSessionCredential(sessionCredential)
      : 'preauth';

    const maxAgeSeconds = sessionCredential
      ? SESSION_ABSOLUTE_MS / 1000
      : PREAUTH_CSRF_TTL_SECONDS;
    if (
      !this.security.matchesDoubleSubmit(cookieToken, headerValue) ||
      !this.security.verifyCsrfToken(
        cookieToken ?? '',
        subject,
        Date.now(),
        maxAgeSeconds,
      )
    ) {
      throw new ForbiddenException({
        code: 'CSRF_VALIDATION_FAILED',
        message: 'Request could not be verified.',
      });
    }
    return true;
  }
}
