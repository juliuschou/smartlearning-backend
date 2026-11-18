import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { isValidPasswordInput } from './login.dto';

@ValidatorConstraint({ name: 'accountDisplayName', async: false })
class AccountDisplayNameConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      typeof value === 'string' &&
      value.trim().length > 0 &&
      Array.from(value).length <= 100
    );
  }

  defaultMessage(): string {
    return 'name must contain between 1 and 100 characters';
  }
}

@ValidatorConstraint({ name: 'accountPasswordPolicy', async: false })
class AccountPasswordPolicyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidPasswordInput(value);
  }

  defaultMessage(): string {
    return 'newPassword must contain at least 8 Unicode code points and no more than 1024 UTF-8 bytes';
  }
}

export class UpdateOwnProfileDto {
  @ApiPropertyOptional({
    description: '本人姓名，去除前後空白後 1–100 個 Unicode 字元。',
    example: '王小明',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Validate(AccountDisplayNameConstraint)
  name?: string;

  // null 表示清除電話；未提供欄位則保留原值，兩者意思不同。
  @ApiPropertyOptional({
    description: '本人聯絡電話，可為 null 清除；使用含國碼的 E.164 格式。',
    example: '+886912345678',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(15)
  @Matches(/^\+[0-9]{1,14}$/)
  phone?: string | null;
}

export class ChangeOwnPasswordDto {
  @ApiProperty({ description: '目前密碼。', minLength: 1, maxLength: 1024 })
  @IsString()
  @MaxLength(1024)
  currentPassword!: string;

  @ApiProperty({
    description: '新密碼；至少 8 個 Unicode 字元，最多 1024 UTF-8 bytes。',
    minLength: 8,
    maxLength: 1024,
  })
  @IsString()
  @Validate(AccountPasswordPolicyConstraint)
  newPassword!: string;
}

export class OwnProfileResponseDto {
  @ApiProperty({ example: 'verified.teacher@example.test' })
  email!: string;

  @ApiProperty({ example: '王小明' })
  name!: string;

  @ApiPropertyOptional({ example: '+886912345678', nullable: true })
  phone!: string | null;
}
