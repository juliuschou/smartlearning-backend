import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTeacherDto } from './create-teacher.dto';

describe('CreateTeacherDto', () => {
  const valid = {
    name: '王小明',
    accountName: 'teacher.wang',
    email: 'teacher.wang@example.test',
  };

  it('accepts a valid payload with optional phone', async () => {
    const dto = plainToInstance(CreateTeacherDto, {
      ...valid,
      phone: '+886912345678',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts the payload without phone', async () => {
    const dto = plainToInstance(CreateTeacherDto, { ...valid });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('trims leading and trailing whitespace before validation', async () => {
    const dto = plainToInstance(CreateTeacherDto, {
      ...valid,
      email: ` ${valid.email} `,
      accountName: ' teacher.wang ',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.email).toBe(valid.email);
    expect(dto.accountName).toBe(valid.accountName);
  });

  it('rejects an accountName outside 3-32 characters or forbidden characters', async () => {
    for (const accountName of [
      'ab',
      'teacher.wang.wang.wang.wang!',
      '師帳號',
    ]) {
      const dto = plainToInstance(CreateTeacherDto, {
        ...valid,
        accountName,
      });
      const errors = await validate(dto);
      expect(errors.some((error) => error.property === 'accountName')).toBe(
        true,
      );
    }
  });

  it('rejects a name over 100 characters after trimming', async () => {
    const dto = plainToInstance(CreateTeacherDto, {
      ...valid,
      name: `${'a'.repeat(101)}`,
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'name')).toBe(true);
  });

  it('rejects an invalid or overlong email', async () => {
    for (const email of ['not-an-email', `a${'b'.repeat(255)}@example.test`]) {
      const dto = plainToInstance(CreateTeacherDto, { ...valid, email });
      const errors = await validate(dto);
      expect(errors.some((error) => error.property === 'email')).toBe(true);
    }
  });

  it('rejects a phone not in E.164 format', async () => {
    const dto = plainToInstance(CreateTeacherDto, {
      ...valid,
      phone: '0912-345-678',
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'phone')).toBe(true);
  });
});
