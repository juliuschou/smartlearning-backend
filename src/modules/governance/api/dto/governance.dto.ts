import { IsBoolean, IsIn, IsOptional, IsInt, Max, Min } from 'class-validator';
import type { Page } from '../../../../common/pagination';

export class ArchiveListQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class DeletionRequestDto {
  @IsOptional()
  @IsIn(['privacy', 'support', 'retention'])
  reason?: string;
}

export class DeletionConfirmDto {
  @IsBoolean()
  confirmed!: boolean;

  @IsIn(['privacy', 'support', 'retention'])
  reason!: string;
}

export interface ArchiveSummaryDto {
  id: string;
  liveSessionId: string;
  courseId: string;
  closedAt: string;
  purgeAt: string;
  status: string;
}

export type ArchivePageDto = Page<ArchiveSummaryDto>;
