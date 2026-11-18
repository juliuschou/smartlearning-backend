import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  RequestPasswordResetDto,
  ResetPasswordDto,
} from './password-reset.dto';

describe('Password reset DTOs', () => {
  // 重設密碼的輸入只接受合規信箱、一次性值與符合長度要求的新密碼。
  it('trims valid request Email', async () => {
    const dto = plainToInstance(RequestPasswordResetDto, {
      email: ' User@example.test ',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.email).toBe('User@example.test');
  });

  it('rejects malformed reset request Email', async () => {
    const dto = plainToInstance(RequestPasswordResetDto, {
      email: 'not-an-email',
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain('email');
  });

  it('accepts an opaque token and policy-compliant new password', async () => {
    const dto = plainToInstance(ResetPasswordDto, {
      token: 'a'.repeat(43),
      newPassword: 'new-password',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects an invalid token shape and a short password', async () => {
    const dto = plainToInstance(ResetPasswordDto, {
      token: 'short',
      newPassword: 'short',
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['token', 'newPassword']),
    );
  });
});
