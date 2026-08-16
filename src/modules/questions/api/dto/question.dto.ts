import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  POLL_MAX_OPTION_LENGTH,
  POLL_MAX_OPTION_REF_LENGTH,
  POLL_MAX_PROMPT_LENGTH,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
} from '../../domain/poll-single-choice';

function normalizeQuestionText(value: unknown): unknown {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(/\s+/gu, ' ').trim()
    : value;
}

@ValidatorConstraint({ name: 'codePointMaxLength', async: false })
class CodePointMaxLengthConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const maxLength = args.constraints[0] as number;
    return typeof value === 'string' && [...value].length <= maxLength;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must contain no more than ${args.constraints[0]} characters.`;
  }
}

export class CreateQuestionOptionDto {
  @IsOptional()
  @Transform(({ value }) => normalizeQuestionText(value))
  @IsString()
  @MinLength(1)
  @Validate(CodePointMaxLengthConstraint, [POLL_MAX_OPTION_REF_LENGTH])
  optionRef?: string;

  @Transform(({ value }) => normalizeQuestionText(value))
  @IsString()
  @MinLength(1)
  @Validate(CodePointMaxLengthConstraint, [POLL_MAX_OPTION_LENGTH])
  text!: string;
}

export class CreateQuestionDto {
  @IsIn(['poll'])
  type!: 'poll';

  @Transform(({ value }) => normalizeQuestionText(value))
  @IsString()
  @MinLength(1)
  @Validate(CodePointMaxLengthConstraint, [POLL_MAX_PROMPT_LENGTH])
  prompt!: string;

  @IsIn(['single'])
  selectionMode!: 'single';

  @IsArray()
  @ArrayMinSize(POLL_MIN_OPTIONS)
  @ArrayMaxSize(POLL_MAX_OPTIONS)
  @ValidateNested({ each: true })
  @Type(() => CreateQuestionOptionDto)
  options!: CreateQuestionOptionDto[];
}

export class QuestionOptionDto {
  id!: string;
  optionRef!: string | null;
  text!: string;
  position!: number;
}

export class QuestionDto {
  id!: string;
  courseId!: string;
  type!: string;
  prompt!: string;
  selectionMode!: string | null;
  position!: number;
  options!: QuestionOptionDto[];
  createdAt!: string;
  updatedAt!: string;
}
