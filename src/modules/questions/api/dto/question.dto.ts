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
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MAX_OPTION_LENGTH,
  MAX_OPTION_REF_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_OPTIONS,
  MIN_OPTIONS,
} from '../../domain/question-contract';

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
  @Validate(CodePointMaxLengthConstraint, [MAX_OPTION_REF_LENGTH])
  optionRef?: string;

  @Transform(({ value }) => normalizeQuestionText(value))
  @IsString()
  @MinLength(1)
  @Validate(CodePointMaxLengthConstraint, [MAX_OPTION_LENGTH])
  text!: string;
}

/**
 * Create a question of any supported type. The DTO performs light edge
 * validation (types, lengths, nesting); the domain validator
 * (`normalizeQuestion`) enforces the full per-type contract (forbidden/required
 * fields per type, option bounds, duplicate detection, quiz correctness).
 */
export class CreateQuestionDto {
  @IsIn(['poll', 'open_text', 'quiz'])
  type!: 'poll' | 'open_text' | 'quiz';

  @Transform(({ value }) => normalizeQuestionText(value))
  @IsString()
  @MinLength(1)
  @Validate(CodePointMaxLengthConstraint, [MAX_PROMPT_LENGTH])
  prompt!: string;

  @IsOptional()
  @IsIn(['single', 'multiple'])
  selectionMode?: 'single' | 'multiple';

  @IsOptional()
  @IsArray()
  @ArrayMinSize(MIN_OPTIONS)
  @ArrayMaxSize(MAX_OPTIONS)
  @ValidateNested({ each: true })
  @Type(() => CreateQuestionOptionDto)
  options?: CreateQuestionOptionDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  correctOptionRefs?: string[];
}

/**
 * Full-replace update for a question. Same shape as create; the question's
 * type/selectionMode must match the existing persisted type/selectionMode
 * (the service re-validates and rejects a type change within this slice).
 * Options are fully replaced (delete + recreate) to avoid optionRef/position
 * partial-merge conflicts.
 */
export class UpdateQuestionDto {
  @IsIn(['poll', 'open_text', 'quiz'])
  type!: 'poll' | 'open_text' | 'quiz';

  @Transform(({ value }) => normalizeQuestionText(value))
  @IsString()
  @MinLength(1)
  @Validate(CodePointMaxLengthConstraint, [MAX_PROMPT_LENGTH])
  prompt!: string;

  @IsOptional()
  @IsIn(['single', 'multiple'])
  selectionMode?: 'single' | 'multiple';

  @IsOptional()
  @IsArray()
  @ArrayMinSize(MIN_OPTIONS)
  @ArrayMaxSize(MAX_OPTIONS)
  @ValidateNested({ each: true })
  @Type(() => CreateQuestionOptionDto)
  options?: CreateQuestionOptionDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  correctOptionRefs?: string[];
}

/**
 * Reorder request body — the complete desired order of every question in the
 * course, expressed as question IDs. The service requires the submitted set
 * to exactly equal the course's current question set (no missing/extra/
 * duplicate IDs) and reassigns positions 1..N in the given order.
 */
export class ReorderQuestionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  questionIds!: string[];
}

export class QuestionOptionDto {
  @ApiProperty()
  id!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  optionRef!: string | null;

  @ApiProperty()
  text!: string;

  @ApiProperty()
  position!: number;

  @ApiProperty()
  isCorrect!: boolean;
}

export class QuestionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  courseId!: string;

  @ApiProperty()
  type!: string;

  @ApiProperty()
  prompt!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  selectionMode!: string | null;

  @ApiProperty()
  position!: number;

  @ApiProperty({ type: () => QuestionOptionDto, isArray: true })
  options!: QuestionOptionDto[];

  @ApiProperty({ type: () => String, isArray: true })
  correctOptionRefs!: string[];

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}
