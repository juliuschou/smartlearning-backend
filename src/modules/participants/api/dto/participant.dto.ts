import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MinLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

function normalizeDisplayNameInput(value: unknown): unknown {
  return typeof value === 'string' ? value.normalize('NFC').trim() : value;
}

@ValidatorConstraint({ name: 'displayNameCodePointMaxLength', async: false })
class DisplayNameCodePointMaxLengthConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const maxLength = args.constraints[0] as number;
    return typeof value === 'string' && [...value].length <= maxLength;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must contain no more than ${args.constraints[0]} characters.`;
  }
}

export class JoinLiveSessionDto {
  /** Required for anonymous joins; ignored for authenticated students. */
  @ApiProperty({ required: false })
  @IsOptional()
  @Transform(({ value }) => normalizeDisplayNameInput(value))
  @IsString()
  @MinLength(1)
  @Validate(DisplayNameCodePointMaxLengthConstraint, [40])
  displayName?: string;
}

export class ParticipantDto {
  id!: string;
  liveSessionId!: string;
  displayName!: string;
  joinedAt!: string;
}

export class JoinLiveSessionResponseDto {
  participantId!: string;

  @ApiProperty({ nullable: true, type: String })
  participantToken!: string | null;

  liveSession!: {
    id: string;
    status: string;
    sessionCode: string;
  };
  currentQuestion!: unknown | null;
}
