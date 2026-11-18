import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;
export const SESSION_COOKIE_MAX_AGE_MS = SESSION_ABSOLUTE_MS;
export const SESSION_COOKIE_PATH = '/';
export const SESSION_COOKIE_NAME = 'sl_session';
export const CSRF_COOKIE_NAME = 'sl_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const PREAUTH_CSRF_TTL_SECONDS = 15 * 60;

@Injectable()
export class AuthConfig {
  constructor(private readonly config: ConfigService) {}

  get isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  get sessionCookieName(): string {
    return SESSION_COOKIE_NAME;
  }

  get sessionCookieSecure(): boolean {
    return (
      this.isProduction ||
      this.config.get<string>('SESSION_COOKIE_SECURE') === 'true'
    );
  }

  get allowedOrigins(): ReadonlySet<string> {
    const value = this.config.get<string>('CORS_ORIGIN') ?? '';
    const origins = value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);

    // 來源採精確清單，不接受萬用設定或帶路徑的網址，避免意外放行其他網站。
    const normalized = new Set<string>();
    for (const origin of origins) {
      if (origin === '*') {
        throw new Error('CORS_ORIGIN must not contain a wildcard.');
      }

      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error('CORS_ORIGIN must contain exact HTTP(S) origins.');
      }
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.origin !== origin ||
        parsed.username !== '' ||
        parsed.password !== ''
      ) {
        throw new Error('CORS_ORIGIN must contain exact HTTP(S) origins.');
      }
      normalized.add(origin);
    }
    return normalized;
  }

  // 設定不足或仍是範例值時直接拒絕服務，不以較弱的預設值繼續運作。
  get cookieSigningSecret(): Buffer {
    const secret = this.config.get<string>('COOKIE_SECRET');
    if (
      !secret ||
      secret.toLowerCase().includes('replace-with') ||
      Buffer.byteLength(secret, 'utf8') < 32
    ) {
      throw new ServiceUnavailableException({
        code: 'AUTH_SERVICE_UNAVAILABLE',
        message: 'Authentication service is unavailable.',
      });
    }
    return Buffer.from(secret, 'utf8');
  }

  assertSessionDurations(): void {
    const idle = this.config.get<string>('SESSION_IDLE_MS');
    const absolute = this.config.get<string>('SESSION_ABSOLUTE_MS');
    if (
      (idle !== undefined && Number(idle) !== SESSION_IDLE_MS) ||
      (absolute !== undefined && Number(absolute) !== SESSION_ABSOLUTE_MS)
    ) {
      throw new ServiceUnavailableException({
        code: 'AUTH_SERVICE_UNAVAILABLE',
        message: 'Authentication service is unavailable.',
      });
    }
  }
}
