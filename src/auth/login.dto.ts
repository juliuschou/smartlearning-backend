import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

// 同時限制使用者看得到的字數與實際傳輸大小，避免多位元字元繞過長度限制。
export function isValidPasswordInput(value: string): boolean {
  return [...value].length >= 8 && Buffer.byteLength(value, 'utf8') <= 1024;
}

@ValidatorConstraint({ name: 'passwordPolicy', async: false })
class PasswordPolicyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidPasswordInput(value);
  }

  defaultMessage(): string {
    return 'password must contain at least 8 Unicode code points and be no more than 1024 UTF-8 bytes';
  }
}

export class LoginDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Validate(PasswordPolicyConstraint)
  password!: string;
}
