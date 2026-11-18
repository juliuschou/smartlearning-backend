import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AuthConfig,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE_MAX_AGE_MS,
  SESSION_COOKIE_PATH,
} from './auth.config';

export interface CsrfCookieOptions {
  httpOnly: false;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
}

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
}

@Injectable()
export class AuthSecurityService {
  constructor(private readonly config: AuthConfig) {}

  createSessionCredential(): string {
    return randomBytes(32).toString('base64url');
  }

  createOneTimeCredential(): string {
    return randomBytes(32).toString('base64url');
  }

  hashSessionCredential(credential: string): string {
    return createHash('sha256').update(credential, 'utf8').digest('hex');
  }

  hashOneTimeCredential(credential: string): string {
    return createHash('sha256').update(credential, 'utf8').digest('hex');
  }

  createCsrfToken(subject: string, now = Date.now()): string {
    // 把產生時間和隨機內容一起加上只有伺服器能辨認的記號，之後可查出有沒有被竄改或過期。
    const issuedAt = Math.floor(now / 1000).toString();
    const nonce = randomBytes(24).toString('base64url');
    const signature = this.signCsrf(subject, issuedAt, nonce);
    return `${issuedAt}.${nonce}.${signature}`;
  }

  verifyCsrfToken(
    token: string,
    subject: string,
    now = Date.now(),
    maxAgeSeconds = SESSION_ABSOLUTE_MS / 1000,
  ): boolean {
    const [issuedAt, nonce, signature, extra] = token.split('.');
    if (!issuedAt || !nonce || !signature || extra !== undefined) return false;
    if (!/^\d+$/.test(issuedAt) || !/^[A-Za-z0-9_-]{20,}$/.test(nonce)) {
      return false;
    }
    const issuedAtSeconds = Number(issuedAt);
    const nowSeconds = Math.floor(now / 1000);
    if (
      !Number.isSafeInteger(issuedAtSeconds) ||
      issuedAtSeconds > nowSeconds ||
      nowSeconds - issuedAtSeconds >= maxAgeSeconds
    ) {
      return false;
    }

    // 用固定時間比對簽章，避免比對過程的快慢透露內容是否接近正確。
    const expected = Buffer.from(this.signCsrf(subject, issuedAt, nonce));
    const actual = Buffer.from(signature);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  matchesDoubleSubmit(
    cookieToken: string | undefined,
    headerToken: string | undefined,
  ): boolean {
    if (!cookieToken || !headerToken) return false;
    const cookie = Buffer.from(cookieToken);
    const header = Buffer.from(headerToken);
    return cookie.length === header.length && timingSafeEqual(cookie, header);
  }

  // 登入用的值不讓網頁程式直接讀取；另一個防偽值則需由網頁讀出並隨請求送回。
  sessionCookieOptions(): SessionCookieOptions {
    return {
      httpOnly: true,
      secure: this.config.sessionCookieSecure,
      sameSite: 'lax',
      path: SESSION_COOKIE_PATH,
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
    };
  }

  csrfCookieOptions(maxAge = SESSION_ABSOLUTE_MS): CsrfCookieOptions {
    return {
      httpOnly: false,
      secure: this.config.sessionCookieSecure,
      sameSite: 'lax',
      path: SESSION_COOKIE_PATH,
      maxAge,
    };
  }

  private signCsrf(subject: string, issuedAt: string, nonce: string): string {
    return createHmac('sha256', this.config.cookieSigningSecret)
      .update(`csrf-v1\n${subject}\n${issuedAt}\n${nonce}`, 'utf8')
      .digest('base64url');
  }
}
