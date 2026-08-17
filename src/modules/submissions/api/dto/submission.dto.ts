import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
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

function normalizeTextAnswer(value: unknown): unknown {
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

  // Shape-only validation. The selectedOptionRefs/textAnswer mutual exclusion
  // and type-specific cardinality are enforced by the application layer against
  // the SessionQuestion snapshot type (the DTO cannot know the question type
  // from the request body alone).
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(10)
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map(normalizeSubmissionRef) : value,
  )
  @IsString({ each: true })
  @Validate(SubmissionRefCodePointMaxLengthConstraint, [250], {
    each: true,
  })
  selectedOptionRefs?: string[];

  @IsOptional()
  @IsString()
  @Transform(({ value }) => normalizeTextAnswer(value))
  @Validate(SubmissionRefCodePointMaxLengthConstraint, [2_000])
  textAnswer?: string;
}

export class SubmissionDto {
  id!: string;
  liveSessionId!: string;
  sessionQuestionId!: string;
  participantId!: string;
  selectedOptionRefs!: string[] | null;
  textAnswer!: string | null;
  submittedAt!: string;
}
