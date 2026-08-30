import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCliCredentialDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @ApiProperty()
  name!: string;
}

export class CliCredentialDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  accountId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  scope!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({ nullable: true, type: String })
  lastUsedAt!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty({ nullable: true, type: String })
  revokedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  rotatedFromId!: string | null;
}

export class CreateCliCredentialResponseDto extends CliCredentialDto {
  @ApiProperty()
  rawKey!: string;
}

export class RotateCliCredentialResponseDto extends CliCredentialDto {
  @ApiProperty()
  rawKey!: string;
}
