import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Account response projection — never includes password_hash.
 * Wire contract: UUID id, UTC timestamps, stable field names.
 */
export class AccountDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty()
  role!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  canCreateCourse!: boolean;

  @ApiProperty()
  mustChangePassword!: boolean;

  @ApiPropertyOptional({ nullable: true, type: String })
  disabledAt!: string | null;

  @ApiProperty()
  createdAt!: string;
}

export class SessionDto {
  @ApiProperty()
  accountId!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty()
  role!: string;

  @ApiProperty()
  canCreateCourse!: boolean;

  @ApiProperty()
  mustChangePassword!: boolean;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  expiresAt!: string;
}
