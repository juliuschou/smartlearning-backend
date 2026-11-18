import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { isValidPasswordInput } from './login.dto';

@ValidatorConstraint({ name: 'passwordResetPasswordPolicy', async: false })
class PasswordResetPasswordPolicyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidPasswordInput(value);
  }

  defaultMessage(): string {
    return 'newPassword does not meet the password policy';
  }
}

export class RequestPasswordResetDto {
  @ApiProperty({
    description: '帳號 Email。無論帳號是否符合重設資格，回應均一致。',
    maxLength: 254,
    example: 'teacher@example.test',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({
    description: '由密碼重設 Email 一次性連結提供的 token。',
    minLength: 40,
    maxLength: 64,
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{40,64}$/)
  token!: string;

  @ApiProperty({
    description: '新密碼；至少 8 個 Unicode 字元，最多 1024 UTF-8 bytes。',
    minLength: 8,
    maxLength: 1024,
  })
  @IsString()
  @Validate(PasswordResetPasswordPolicyConstraint)
  newPassword!: string;
}
