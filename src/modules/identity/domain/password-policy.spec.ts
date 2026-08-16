import {
  validatePassword,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PasswordPolicyError,
} from './password-policy';

describe('password-policy', () => {
  it('accepts a 12-character password (minimum boundary)', () => {
    expect(() => validatePassword('a'.repeat(12))).not.toThrow();
  });

  it('accepts a 128-character password (maximum boundary)', () => {
    expect(() => validatePassword('a'.repeat(128))).not.toThrow();
  });

  it('accepts multibyte Unicode passphrases by code point count', () => {
    // Exactly 12 code points (CJK), multi-byte in UTF-8 but valid per policy.
    expect(() => validatePassword('一二三四五六七八九十甲乙')).not.toThrow();
  });

  it('rejects empty password', () => {
    expect(() => validatePassword('')).toThrow(PasswordPolicyError);
  });

  it('rejects 11-character password (below minimum)', () => {
    expect(() => validatePassword('a'.repeat(11))).toThrow(PasswordPolicyError);
  });

  it('rejects 129-character password (above maximum)', () => {
    expect(() => validatePassword('a'.repeat(129))).toThrow(
      PasswordPolicyError,
    );
  });

  it('exposes the configured bounds', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });
});
