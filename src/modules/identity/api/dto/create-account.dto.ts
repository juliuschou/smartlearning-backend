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
 * supplied by the admin and hashed with Argon2id before storage.
 *
 * Slice note: `must_change_password` is forced false in this slice (forced
 * first-login change is deferred). The flag is kept on the model for later.
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
