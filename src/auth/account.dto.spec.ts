import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChangeOwnPasswordDto, UpdateOwnProfileDto } from './account.dto';

describe('M01 account DTOs', () => {
  // 確認個人資料會整理姓名格式，也允許把可選的電話清除。
  it('trims a valid profile name and allows clearing the optional phone', async () => {
    const dto = plainToInstance(UpdateOwnProfileDto, {
      name: ' 王小明 ',
      phone: null,
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.name).toBe('王小明');
    expect(dto.phone).toBeNull();
  });

  it('rejects invalid names and non-E.164 phone values', async () => {
    const dto = plainToInstance(UpdateOwnProfileDto, {
      name: '   ',
      phone: '0912345678',
    });
    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['name', 'phone']),
    );
  });

  it('accepts a new password of at least eight Unicode code points', async () => {
    const dto = plainToInstance(ChangeOwnPasswordDto, {
      currentPassword: 'existing-password',
      newPassword: '密碼😀abcde',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects a new password shorter than eight Unicode code points', async () => {
    const dto = plainToInstance(ChangeOwnPasswordDto, {
      currentPassword: 'existing-password',
      newPassword: '短密碼',
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain('newPassword');
  });
});
