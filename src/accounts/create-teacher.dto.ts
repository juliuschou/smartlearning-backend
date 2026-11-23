import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

// M03 老師基本資料規則：姓名必填，去除前後空白後 1–100 個 Unicode code point。
export function isValidNameInput(value: string): boolean {
  const codePoints = [...value.trim()].length;
  return codePoints >= 1 && codePoints <= 100;
}

// M03 帳號名稱規則：限英數與 . _ -，3–32 字元；唯一性不分大小寫由服務層判斷。
export function isValidAccountName(value: string): boolean {
  return /^[A-Za-z0-9._-]{3,32}$/.test(value);
}

export class CreateTeacherDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{3,32}$/, {
    message:
      'accountName must be 3-32 characters limited to letters, digits, dot, underscore, and hyphen',
  })
  accountName!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // 聯絡電話選填；提供時採含國碼的 E.164 格式，最多 15 位數字。
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/^\+[1-9][0-9]{1,14}$/, {
    message: 'phone must be a valid E.164 number including country code',
  })
  phone?: string;
}
