import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const ROLE_CODES = ['SYSTEM_ADMIN', 'TEACHER'] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export const ROLE_STATUSES = ['ENABLED', 'DISABLED'] as const;
export type RoleStatus = (typeof ROLE_STATUSES)[number];

export class UpdateRoleStatusDto {
  @ApiProperty({ enum: ROLE_STATUSES, example: 'DISABLED' })
  @IsIn(ROLE_STATUSES)
  status!: RoleStatus;
}

export class RoleResponseDto {
  @ApiProperty({ enum: ROLE_CODES, example: 'TEACHER' })
  roleCode!: RoleCode;

  @ApiProperty({ example: '老師' })
  name!: string;

  @ApiProperty({ example: '維護題庫並主持教學活動。' })
  description!: string;

  @ApiProperty({ enum: ROLE_STATUSES, example: 'ENABLED' })
  status!: RoleStatus;

  @ApiProperty({ example: true })
  isSystemReserved!: boolean;
}

export class RoleDetailResponseDto extends RoleResponseDto {
  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        permissionCode: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { enum: ['ENABLED', 'DISABLED'] },
      },
    },
  })
  permissions!: Array<{
    permissionCode: string;
    name: string;
    description: string;
    status: RoleStatus;
  }>;
}
