import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  Equals,
} from 'class-validator';
import {
  OpenTextResultsDto,
  PollResultsDto,
  QuizResultsDto,
  type SessionQuestionResultsDto,
} from '../../../live-sessions/api/dto';

export const ARCHIVE_STATUSES = ['active', 'deleted'] as const;
export const DELETION_REASONS = ['privacy', 'support'] as const;
export type ArchiveStatus = (typeof ARCHIVE_STATUSES)[number];
export type DeletionReason = (typeof DELETION_REASONS)[number];
export type DeletionTrigger = 'early_delete' | 'retention';

export class ArchiveListQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  courseId?: string;

  @ApiPropertyOptional({ enum: ARCHIVE_STATUSES })
  @IsOptional()
  @IsIn(ARCHIVE_STATUSES)
  status?: ArchiveStatus;
}

export class DeletionRequestListQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional({ enum: ['requested'], default: 'requested' })
  @IsOptional()
  @IsIn(['requested'])
  status?: 'requested';
}

export class DeletionRequestDto {
  @ApiProperty({ enum: DELETION_REASONS })
  @IsIn(DELETION_REASONS)
  reason!: DeletionReason;
}

export class DeletionConfirmDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  deletionRequestId!: string;

  @ApiProperty({ enum: [true] })
  @Equals(true)
  confirmed!: true;

  @ApiProperty({ enum: DELETION_REASONS })
  @IsIn(DELETION_REASONS)
  reason!: DeletionReason;
}

export class ArchiveCourseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;
}

export class DeletionRequestSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: DELETION_REASONS })
  reason!: DeletionReason;

  @ApiProperty({ enum: ['requested'] })
  status!: 'requested';

  @ApiProperty({ format: 'date-time' })
  requestedAt!: string;
}

export class ArchiveDeletionDto {
  @ApiProperty({ enum: ['early_delete', 'retention'] })
  trigger!: DeletionTrigger;

  @ApiProperty({ enum: [...DELETION_REASONS, 'retention'] })
  reason!: DeletionReason | 'retention';

  @ApiProperty({ format: 'date-time' })
  deletedAt!: string;
}

export class ArchiveSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  liveSessionId!: string;

  @ApiProperty({ type: () => ArchiveCourseDto })
  course!: ArchiveCourseDto;

  @ApiProperty()
  sessionLabel!: string;

  @ApiProperty({ format: 'date-time' })
  startedAt!: string;

  @ApiProperty({ format: 'date-time' })
  closedAt!: string;

  @ApiProperty({ enum: ARCHIVE_STATUSES })
  status!: ArchiveStatus;

  @ApiProperty({ format: 'date-time' })
  purgeAt!: string;

  @ApiPropertyOptional({
    type: () => DeletionRequestSummaryDto,
    nullable: true,
  })
  deletionRequest!: DeletionRequestSummaryDto | null;

  @ApiPropertyOptional({ type: () => ArchiveDeletionDto, nullable: true })
  deletion!: ArchiveDeletionDto | null;
}

export class ArchivedQuestionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ minimum: 1 })
  position!: number;

  @ApiProperty()
  prompt!: string;

  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(PollResultsDto) },
      { $ref: getSchemaPath(QuizResultsDto) },
      { $ref: getSchemaPath(OpenTextResultsDto) },
    ],
    discriminator: { propertyName: 'snapshotType' },
  })
  result!: SessionQuestionResultsDto;
}

export class ArchivedResultPayloadDto {
  @ApiProperty({ enum: [1] })
  schemaVersion!: 1;

  @ApiProperty({ type: () => ArchivedQuestionDto, isArray: true })
  questions!: ArchivedQuestionDto[];
}

export class ActiveArchiveDetailDto extends ArchiveSummaryDto {
  @ApiProperty({ enum: ['active'] })
  declare status: 'active';

  @ApiProperty({ type: () => ArchivedResultPayloadDto })
  payload!: ArchivedResultPayloadDto;
}

export class DeletedArchiveDetailDto extends ArchiveSummaryDto {
  @ApiProperty({ enum: ['deleted'] })
  declare status: 'deleted';

  @ApiProperty({ type: () => ArchiveDeletionDto })
  declare deletion: ArchiveDeletionDto;
}

export type ArchiveDetailDto = ActiveArchiveDetailDto | DeletedArchiveDetailDto;

export class DeletionRequestReceiptDto extends DeletionRequestSummaryDto {
  @ApiProperty({ format: 'uuid' })
  liveSessionId!: string;
}

export class AdminDeletionRequestSummaryDto extends DeletionRequestReceiptDto {
  @ApiProperty({ type: () => ArchiveCourseDto })
  course!: ArchiveCourseDto;

  @ApiProperty()
  sessionLabel!: string;

  @ApiProperty({ format: 'date-time' })
  startedAt!: string;

  @ApiProperty({ format: 'date-time' })
  closedAt!: string;

  @ApiProperty({ format: 'date-time' })
  purgeAt!: string;
}

export class DeletionResultDto {
  @ApiProperty({ format: 'uuid' })
  archiveId!: string;

  @ApiProperty({ format: 'uuid' })
  liveSessionId!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  deletionRequestId!: string | null;

  @ApiProperty({ enum: ['deleted'] })
  status!: 'deleted';

  @ApiProperty({ type: () => ArchiveDeletionDto })
  deletion!: ArchiveDeletionDto;
}

export class PageMetaDto {
  @ApiProperty()
  page!: number;
  @ApiProperty()
  pageSize!: number;
  @ApiProperty()
  total!: number;
  @ApiProperty()
  totalPages!: number;
}

export class ArchivePageDto {
  @ApiProperty({ type: () => ArchiveSummaryDto, isArray: true })
  data!: ArchiveSummaryDto[];
  @ApiProperty({ type: () => PageMetaDto })
  meta!: PageMetaDto;
}

export class DeletionRequestPageDto {
  @ApiProperty({ type: () => AdminDeletionRequestSummaryDto, isArray: true })
  data!: AdminDeletionRequestSummaryDto[];
  @ApiProperty({ type: () => PageMetaDto })
  meta!: PageMetaDto;
}
