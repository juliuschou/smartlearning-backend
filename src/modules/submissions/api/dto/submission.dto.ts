import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

function normalizeSubmissionRef(value: unknown): unknown {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(/\s+/gu, ' ').trim()
    : value;
}

@ValidatorConstraint({ name: 'submissionRefCodePointMaxLength', async: false })
class SubmissionRefCodePointMaxLengthConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const maxLength = args.constraints[0] as number;
    return typeof value === 'string' && [...value].length <= maxLength;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must contain no more than ${args.constraints[0]} characters.`;
  }
}

export class CreateSubmissionDto {
  @IsUUID()
  sessionQuestionId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1)
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map(normalizeSubmissionRef) : value,
  )
  @IsString({ each: true })
  @Validate(SubmissionRefCodePointMaxLengthConstraint, [250], {
    each: true,
  })
  selectedOptionRefs!: string[];
}

export class SubmissionDto {
  id!: string;
  liveSessionId!: string;
  sessionQuestionId!: string;
  participantId!: string;
  selectedOptionRefs!: string[];
  submittedAt!: string;
}
