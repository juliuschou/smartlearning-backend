import {
  LOGIN_RATE_LIMIT_NAMESPACE,
  LoginRateLimitKeyFactory,
} from './login-rate-limit-key.factory';

describe('LoginRateLimitKeyFactory', () => {
  const factory = new LoginRateLimitKeyFactory('a'.repeat(32));

  it('generates deterministic opaque account and source keys', () => {
    const account = factory.account('alice');
    const source = factory.source('203.0.113.10');

    expect(account).toBe(factory.account('alice'));
    expect(source).toBe(factory.source('203.0.113.10'));
    expect(account.startsWith(`${LOGIN_RATE_LIMIT_NAMESPACE}:account:`)).toBe(
      true,
    );
    expect(source.startsWith(`${LOGIN_RATE_LIMIT_NAMESPACE}:source:`)).toBe(
      true,
    );
    expect(account.split(':').at(-1)).toMatch(/^[0-9a-f]{64}$/);
    expect(source.split(':').at(-1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates account and source domains and hides raw values', () => {
    const account = factory.account('alice');
    const source = factory.source('2001:db8::1');

    expect(account).not.toContain('alice');
    expect(source).not.toContain('2001:db8::1');
    expect(account).not.toBe(source);
    expect(account).not.toContain('smartlearning:socket.io');
    expect(source).not.toContain('smartlearning:socket.io');
  });

  it('normalizes account identifiers before deriving the digest', () => {
    expect(factory.account('  Ａlice  ')).toBe(factory.account('alice'));
    expect(factory.account('alice')).not.toBe(factory.account('bob'));
  });

  it('supports an isolated test namespace', () => {
    const testFactory = new LoginRateLimitKeyFactory(
      'b'.repeat(32),
      'smartlearning:test:login-rate-limit:v1:{login}',
    );
    expect(testFactory.account('alice')).toContain(
      'smartlearning:test:login-rate-limit:',
    );
    expect(testFactory.account('alice')).not.toContain(
      LOGIN_RATE_LIMIT_NAMESPACE,
    );
  });
});
