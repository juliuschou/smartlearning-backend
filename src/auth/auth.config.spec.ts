import { ConfigService } from '@nestjs/config';
import { AuthConfig } from './auth.config';

function createConfig(values: Record<string, string | undefined>): AuthConfig {
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  return new AuthConfig(config);
}

describe('AuthConfig', () => {
  it('parses an exact comma-separated Origin allowlist', () => {
    const config = createConfig({
      CORS_ORIGIN: 'https://app.example.test,http://localhost:3000',
    });

    expect([...config.allowedOrigins]).toEqual([
      'https://app.example.test',
      'http://localhost:3000',
    ]);
  });

  it('fails closed for a wildcard or a non-origin URL', () => {
    expect(() => createConfig({ CORS_ORIGIN: '*' }).allowedOrigins).toThrow();
    expect(
      () =>
        createConfig({ CORS_ORIGIN: 'https://app.example.test/path' })
          .allowedOrigins,
    ).toThrow();
  });

  it('does not allow insecure session cookies in production', () => {
    const config = createConfig({ NODE_ENV: 'production' });
    expect(config.sessionCookieSecure).toBe(true);
    expect(config.sessionCookieName).toBe('sl_session');
  });

  it('rejects placeholder or too-short cookie signing secrets', () => {
    expect(
      () =>
        createConfig({
          COOKIE_SECRET: 'replace-with-a-long-but-placeholder-secret',
        }).cookieSigningSecret,
    ).toThrow();
    expect(
      () => createConfig({ COOKIE_SECRET: 'short' }).cookieSigningSecret,
    ).toThrow();
  });

  it('rejects environment session durations that conflict with M01', () => {
    const config = createConfig({ SESSION_ABSOLUTE_MS: '28800000' });
    expect(() => config.assertSessionDurations()).toThrow();
  });
});
