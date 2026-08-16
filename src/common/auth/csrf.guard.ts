import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { CsrfError } from '../errors';
import { csrfTokensMatch, requestCsrfTokens } from '../security/csrf';
import { isMutation, isOriginAllowed } from '../security/origin';

/**
 * Enforces the double-submit CSRF token and exact Origin allowlist for
 * authenticated state-changing HTTP requests.
 *
 * Login is intentionally not covered: it has no authenticated session yet.
 * Callers compose this guard after SessionGuard on mutation handlers.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!isMutation(req)) {
      return true;
    }

    const allowedOrigins = this.allowedOrigins();
    const originValid = isOriginAllowed(req.get('origin'), allowedOrigins);
    const { cookieToken, headerToken } = requestCsrfTokens(req);
    if (!originValid || !csrfTokensMatch(cookieToken, headerToken)) {
      throw new CsrfError();
    }
    return true;
  }

  private allowedOrigins(): string[] {
    return (this.config.get<string>('CORS_ORIGIN') ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }
}
