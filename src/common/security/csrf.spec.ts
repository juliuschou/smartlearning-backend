import type { Request } from 'express';
import { csrfTokensMatch, generateCsrfToken, requestCsrfTokens } from './csrf';
import { CSRF_COOKIE_NAME, CSRF_HEADER } from './cookies';
import { isMutation, isOriginAllowed } from './origin';

describe('CSRF helpers', () => {
  it('generates a high-entropy token and matches only the same value', () => {
    const token = generateCsrfToken();

    expect(token).toHaveLength(43);
    expect(csrfTokensMatch(token, token)).toBe(true);
    expect(csrfTokensMatch(token, `${token}x`)).toBe(false);
    expect(csrfTokensMatch(undefined, token)).toBe(false);
  });

  it('reads the cookie and header pair from a request', () => {
    const req = {
      cookies: { [CSRF_COOKIE_NAME]: 'cookie-token' },
      get: (name: string) =>
        name === CSRF_HEADER ? 'header-token' : undefined,
    } as unknown as Request;

    expect(requestCsrfTokens(req)).toEqual({
      cookieToken: 'cookie-token',
      headerToken: 'header-token',
    });
  });

  it('matches exact configured origins and rejects missing origins', () => {
    expect(
      isOriginAllowed('http://localhost:3000', ['http://localhost:3000']),
    ).toBe(true);
    expect(isOriginAllowed('http://evil.test', ['http://localhost:3000'])).toBe(
      false,
    );
    expect(isOriginAllowed(undefined, ['http://localhost:3000'])).toBe(false);
    expect(isOriginAllowed('http://localhost:3000', ['*'])).toBe(false);
    expect(isOriginAllowed('*', ['*'])).toBe(false);
  });

  it('protects state-changing methods but not safe reads', () => {
    expect(isMutation({ method: 'POST' } as Request)).toBe(true);
    expect(isMutation({ method: 'PATCH' } as Request)).toBe(true);
    expect(isMutation({ method: 'GET' } as Request)).toBe(false);
    expect(isMutation({ method: 'HEAD' } as Request)).toBe(false);
  });
});
