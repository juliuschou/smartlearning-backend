import { ConfigService } from '@nestjs/config';
import { AuthConfig } from './auth.config';
import { AuthSecurityService } from './auth-security.service';

describe('AuthSecurityService', () => {
  const config = new AuthConfig({
    get: (key: string) =>
      ({ COOKIE_SECRET: 'unit-test-signing-secret-0123456789abcdef' })[key],
  } as unknown as ConfigService);
  const security = new AuthSecurityService(config);

  // 重要資料只保留不可反推的摘要，避免原始登入憑證落在儲存區。
  it('creates unguessable session credentials and stores only their digest', () => {
    const credential = security.createSessionCredential();
    const anotherCredential = security.createSessionCredential();

    expect(credential).not.toBe(anotherCredential);
    expect(credential).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(security.hashSessionCredential(credential)).not.toBe(credential);
    expect(security.hashSessionCredential(credential)).toHaveLength(64);
  });

  it('creates random one-time credentials and hashes them before storage', () => {
    const token = security.createOneTimeCredential();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(security.hashOneTimeCredential(token)).not.toBe(token);
    expect(security.hashOneTimeCredential(token)).toHaveLength(64);
  });

  it('signs CSRF tokens for one subject and rejects tampering or expiry', () => {
    const issuedAt = 1_900_000_000_000;
    const token = security.createCsrfToken('session-hash', issuedAt);

    expect(
      security.verifyCsrfToken(token, 'session-hash', issuedAt + 1000),
    ).toBe(true);
    expect(
      security.verifyCsrfToken(token, 'different-session', issuedAt + 1000),
    ).toBe(false);
    expect(
      security.verifyCsrfToken(
        token,
        'session-hash',
        issuedAt + 24 * 60 * 60 * 1000,
      ),
    ).toBe(false);
    expect(
      security.verifyCsrfToken(`${token}x`, 'session-hash', issuedAt + 1000),
    ).toBe(false);
  });

  it('enforces the shorter pre-authentication CSRF lifetime', () => {
    const issuedAt = 1_900_000_000_000;
    const token = security.createCsrfToken('preauth', issuedAt);

    expect(
      security.verifyCsrfToken(token, 'preauth', issuedAt + 899_000, 900),
    ).toBe(true);
    expect(
      security.verifyCsrfToken(token, 'preauth', issuedAt + 900_000, 900),
    ).toBe(false);
  });

  it('requires cookie and header double-submit values to match', () => {
    const token = security.createCsrfToken('preauth');
    expect(security.matchesDoubleSubmit(token, token)).toBe(true);
    expect(security.matchesDoubleSubmit(token, `${token}x`)).toBe(false);
    expect(security.matchesDoubleSubmit(token, undefined)).toBe(false);
  });

  it('sets the agreed session and CSRF cookie attributes', () => {
    expect(security.sessionCookieOptions()).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 86_400_000,
    });
    expect(security.csrfCookieOptions()).toEqual({
      httpOnly: false,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 86_400_000,
    });
  });
});
