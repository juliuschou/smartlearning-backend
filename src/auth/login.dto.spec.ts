import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { isValidPasswordInput, LoginDto } from './login.dto';

describe('LoginDto', () => {
  it('trims and validates Email while preserving the password exactly', async () => {
    const input = plainToInstance(LoginDto, {
      email: '  User@example.test  ',
      password: '  abcdef  ',
    });

    expect(input.email).toBe('User@example.test');
    expect(input.password).toBe('  abcdef  ');
    expect(await validate(input)).toHaveLength(0);
  });

  it('counts Unicode code points and enforces the UTF-8 byte limit', () => {
    expect(isValidPasswordInput('😀'.repeat(8))).toBe(true);
    expect(isValidPasswordInput('😀'.repeat(7))).toBe(false);
    expect(isValidPasswordInput(' '.repeat(8))).toBe(true);
    expect(isValidPasswordInput('a'.repeat(1024))).toBe(true);
    expect(isValidPasswordInput('a'.repeat(1025))).toBe(false);
  });

  it('rejects unknown properties rather than silently accepting them', async () => {
    const input = plainToInstance(LoginDto, {
      email: 'user@example.test',
      password: 'password123',
      role: 'SYSTEM_ADMIN',
    });

    const errors = await validate(input, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property)).toContain('role');
  });
});
