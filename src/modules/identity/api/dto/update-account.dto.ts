import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ACCOUNT_ROLES, type AccountRole } from '../../domain/roles';

/**
 * Admin account profile update (BE-8.2 CP2). Allowlist is frozen: only
 * `displayName`, `role`, and `canCreateCourse` are mutable here. `username`,
 * `password`/`passwordHash`, `status`/`disabledAt`, and `id`/`createdAt` are
 * intentionally not accepted — the global `forbidNonWhitelisted` pipe rejects
 * any unknown field with 400 `VALIDATION_FAILED`. At least one field must be
 * present; the controller enforces that explicitly for a stable error.
 *
 * `mustChangePassword` is deliberately NOT in this allowlist — it is a
 * quasi-lifecycle flag handled by the dedicated step-up-protected
 * `require-password-change` route (see plan §1.3).
 */
export class UpdateAccountDto {
  @ApiPropertyOptional({
    description: 'New display name (1–100 chars).',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName?: string;

  @ApiPropertyOptional({
    description: 'New account role. Promoting to admin requires step-up.',
    enum: ACCOUNT_ROLES,
  })
  @IsOptional()
  @IsEnum(ACCOUNT_ROLES)
  role?: AccountRole;

  @ApiPropertyOptional({
    description:
      'Whether the account may create courses. Student accounts are always false.',
  })
  @IsOptional()
  @IsBoolean()
  canCreateCourse?: boolean;
}
