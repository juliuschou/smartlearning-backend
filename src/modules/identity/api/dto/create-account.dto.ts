import {
  IsBoolean,
  IsEnum,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ACCOUNT_ROLES, type AccountRole } from '../../domain/roles';

/**
 * Admin creates a teacher/admin account. A one-time temporary password is
 * supplied by the admin and hashed with Argon2id before storage; the account
 * must replace it before using other protected operations.
 */
export class CreateAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;

  @IsEnum(ACCOUNT_ROLES)
  role!: AccountRole;

  @IsBoolean()
  canCreateCourse!: boolean;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  tempPassword!: string;
}
