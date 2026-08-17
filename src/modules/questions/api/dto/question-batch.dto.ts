import {
  IsArray,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Note: the `questions` array on the batch DTOs is typed as `unknown[]` and
 * validated only with `@IsArray()`. The per-question contract is enforced by
 * the domain layer (`validateBatch` → `validateQuestion`), not by the global
 * ValidationPipe. Nest's global pipe uses `forbidNonWhitelisted: true`, which
 * interacts poorly with nested `@ValidateNested`/`@Type` array transforms in
 * e2e (elements become empty objects, recognized fields are flagged
 * `FIELD_FORBIDDEN`). The controller overrides the global pipe with a
 * transform-only, non-whitelisting pipe so the raw payload reaches the domain
 * validator intact. `BatchQuestionInputDto`/`BatchQuestionOptionDto` are kept
 * as classes purely so `@ApiProperty({ type: () => ... })` can emit OpenAPI
 * element schemas; they do not participate in request validation. */

function normalizeBatchText(value: unknown): unknown {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(/\s+/gu, ' ').trim()
    : value;
}

export class BatchQuestionOptionDto {
  @IsOptional()
  @Transform(({ value }) => normalizeBatchText(value))
  @IsString()
  @MinLength(1)
  optionRef?: string;

  @Transform(({ value }) => normalizeBatchText(value))
  @IsString()
  @MinLength(1)
  text!: string;
}

/**
 * OpenAPI schema source for one batch question element. The controller's
 * `@Body` pipe does NOT apply `@ValidateNested` to `questions`, so the
 * class-validator decorators below are not executed for inbound payloads —
 * they are retained so the Swagger plugin (`classValidatorShim`) can infer
 * field enums/types for the OpenAPI element schema, and so the per-field
 * contract stays documented at the DTO layer. Actual inbound validation is
 * performed by `validateBatch` → `validateQuestion` in the domain layer.
 */
export class BatchQuestionInputDto {
  @IsString()
  @MinLength(1)
  @ApiProperty()
  clientRef!: string;

  @IsIn(['poll', 'open_text', 'quiz'])
  @ApiProperty()
  type!: 'poll' | 'open_text' | 'quiz';

  @Transform(({ value }) => normalizeBatchText(value))
  @IsString()
  @MinLength(1)
  @ApiProperty()
  prompt!: string;

  @IsOptional()
  @IsIn(['single', 'multiple'])
  @ApiPropertyOptional()
  selectionMode?: 'single' | 'multiple';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchQuestionOptionDto)
  @ApiPropertyOptional({ type: () => BatchQuestionOptionDto, isArray: true })
  options?: BatchQuestionOptionDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ApiPropertyOptional({ type: () => String, isArray: true })
  correctOptionRefs?: string[];
}

export class ValidateQuestionBatchDto {
  @IsInt()
  @Min(1)
  @ApiProperty()
  schemaVersion!: number;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  courseId?: string;

  @IsArray()
  @ApiProperty({ type: () => BatchQuestionInputDto, isArray: true })
  questions!: unknown[];
}

export class ConfirmQuestionBatchDto {
  @IsInt()
  @Min(1)
  @ApiProperty()
  schemaVersion!: number;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  courseId?: string;

  @IsArray()
  @ApiProperty({ type: () => BatchQuestionInputDto, isArray: true })
  questions!: unknown[];

  @IsString()
  @ApiProperty()
  payloadHash!: string;

  @IsIn([true])
  @ApiProperty()
  confirmed!: true;
}

export class BatchErrorDto {
  @ApiProperty()
  code!: string;

  @ApiPropertyOptional()
  field?: string;

  @ApiProperty()
  message!: string;
}

export class BatchWarningDto {
  @ApiProperty()
  code!: string;

  @ApiPropertyOptional()
  field?: string;

  @ApiProperty()
  message!: string;
}

export class BatchPreviewQuestionDto {
  @ApiProperty()
  clientRef!: string;

  @ApiProperty()
  type!: string;

  @ApiProperty()
  prompt!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  selectionMode!: string | null;

  @ApiPropertyOptional({ type: () => BatchQuestionOptionDto, isArray: true })
  options!: BatchQuestionOptionDto[];

  @ApiPropertyOptional({ type: () => String, isArray: true })
  correctOptionRefs!: string[];
}

export class ValidateBatchResponseDto {
  @ApiProperty()
  schemaVersion!: number;

  @ApiProperty()
  valid!: boolean;

  @ApiProperty()
  payloadHash!: string;

  @ApiProperty({ type: () => BatchErrorDto, isArray: true })
  errors!: BatchErrorDto[];

  @ApiProperty({ type: () => BatchWarningDto, isArray: true })
  warnings!: BatchWarningDto[];

  @ApiPropertyOptional({ type: () => BatchPreviewQuestionDto, isArray: true })
  preview!: BatchPreviewQuestionDto[] | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  validationToken!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  expiresAt!: string | null;
}

export class ConfirmBatchResponseDto {
  @ApiProperty()
  schemaVersion!: number;

  @ApiProperty()
  payloadHash!: string;

  @ApiProperty({ type: () => Object, isArray: true })
  questions!: unknown[];
}
