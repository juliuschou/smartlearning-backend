import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

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
