import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Admin-controlled account permission mutation. This DTO intentionally exposes
 * only the course-creation flag; account lifecycle and CLI credential changes
 * have separate endpoints and semantics.
 */
export class UpdateAccountPermissionsDto {
  @ApiProperty({ description: 'Whether the account may create new courses.' })
  @IsBoolean()
  canCreateCourse!: boolean;
}
