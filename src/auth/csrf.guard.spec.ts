import { ConfigService } from '@nestjs/config';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import {
  AuthConfig,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from './auth.config';
import { AuthSecurityService } from './auth-security.service';
import { CsrfGuard } from './csrf.guard';
import { OriginPolicyService } from './origin-policy.service';

describe('CsrfGuard', () => {
  const configService = {
    get: (key: string) =>
      ({
        CORS_ORIGIN: 'https://app.example.test',
        COOKIE_SECRET: 'csrf-test-signing-secret-0123456789abcdef',
        NODE_ENV: 'test',
      })[key],
  } as unknown as ConfigService;
  const config = new AuthConfig(configService);
  const security = new AuthSecurityService(config);
  const originPolicy = new OriginPolicyService(config);
  const guard = new CsrfGuard(config, security, originPolicy);

  function createContext(input: {
    origin?: string;
    sessionCredential?: string;
    cookieToken?: string;
    headerToken?: string;
  }) {
    const headers: Record<string, string | undefined> = {
      origin: input.origin,
      [CSRF_HEADER_NAME]: input.headerToken,
    };
    const request = {
      method: 'POST',
      cookies: {
        [SESSION_COOKIE_NAME]: input.sessionCredential,
        [CSRF_COOKIE_NAME]: input.cookieToken,
      },
      get: (name: string) => headers[name.toLowerCase()],
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  // 只有核准的來源，加上同一登入狀態產生且兩處相符的值，才可執行寫入操作。
  it('accepts an exact allowlisted Origin and session-bound matching token pair', () => {
    const sessionCredential = 'session-credential';
    const subject = security.hashSessionCredential(sessionCredential);
    const token = security.createCsrfToken(subject);

    expect(
      guard.canActivate(
        createContext({
          origin: 'https://app.example.test',
          sessionCredential,
          cookieToken: token,
          headerToken: token,
        }),
      ),
    ).toBe(true);
  });

  it.each([undefined, 'https://evil.example.test'])(
    'rejects missing or disallowed Origin: %s',
    (origin) => {
      const token = security.createCsrfToken('preauth');
      expect(() =>
        guard.canActivate(
          createContext({
            origin,
            cookieToken: token,
            headerToken: token,
          }),
        ),
      ).toThrow(ForbiddenException);
    },
  );

  it('rejects missing, mismatched, expired, or wrong-subject CSRF tokens', () => {
    const sessionCredential = 'session-credential';
    const correctSubject = security.hashSessionCredential(sessionCredential);
    const wrongSubjectToken = security.createCsrfToken('another-session');
    const validToken = security.createCsrfToken(correctSubject);
    const cases = [
      { cookieToken: undefined, headerToken: validToken },
      { cookieToken: validToken, headerToken: `${validToken}x` },
      { cookieToken: wrongSubjectToken, headerToken: wrongSubjectToken },
    ];

    for (const tokens of cases) {
      expect(() =>
        guard.canActivate(
          createContext({
            origin: 'https://app.example.test',
            sessionCredential,
            ...tokens,
          }),
        ),
      ).toThrow(ForbiddenException);
    }
  });
});
