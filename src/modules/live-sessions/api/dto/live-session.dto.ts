import { normalizeUuid } from '../../../../common/crypto';
import { ApiProperty } from '@nestjs/swagger';
import type { SessionQuestionResultsDto } from './results.dto';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsUUID,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

export const MAX_LIVE_SESSION_QUESTIONS = 50;

@ValidatorConstraint({ name: 'uniqueQuestionIds', async: false })
class UniqueQuestionIdsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    const normalized = value.map((item) =>
      typeof item === 'string' ? normalizeUuid(item) : item,
    );
    return new Set(normalized).size === normalized.length;
  }

  defaultMessage(): string {
    return 'questionIds must not contain duplicates.';
  }
}

export class CreateLiveSessionDto {
  @IsUUID()
  courseId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LIVE_SESSION_QUESTIONS)
  @IsUUID(undefined, { each: true })
  @Validate(UniqueQuestionIdsConstraint)
  questionIds!: string[];
}

export class QuestionSelectionDto {
  @ApiProperty({
    example: '01945f3e-...-uuid-v7',
    description: 'Question definition id.',
  })
  questionDefinitionId!: string;

  @ApiProperty({
    example: 0,
    description: 'Zero-based position within the session.',
  })
  position!: number;
}

export class LiveSessionDto {
  id!: string;
  courseId!: string;
  status!: string;
  sessionCode!: string;
  startedAt!: string | null;
  closedAt!: string | null;
  autoClosed!: boolean;
  createdAt!: string;
  updatedAt!: string;
  @ApiProperty({
    example: 12,
    description: 'Number of participants who joined the session.',
  })
  joinedCount?: number;
  @ApiProperty({
    example: 7,
    description:
      'Number of submissions for the currently open question (0 when no question is open).',
  })
  votedCount?: number;
  @ApiProperty({
    type: () => QuestionSelectionDto,
    isArray: true,
    description: 'Ordered question selections for this session.',
  })
  questionSelections?: QuestionSelectionDto[];
  @ApiProperty({
    type: () => SessionQuestionDto,
    isArray: true,
    description: 'Session questions, ordered by position.',
  })
  sessionQuestions?: SessionQuestionDto[];
  @ApiProperty({
    required: false,
    description: 'Durable realtime sequence and visible question versions.',
  })
  watermark?: {
    eventSeq: string;
    aggregateVersions: Record<string, number>;
  };
  @ApiProperty({
    required: false,
    description: 'Actor-safe aggregate results keyed by session question id.',
  })
  results?: Record<string, SessionQuestionResultsDto>;
}

export class SessionQuestionOptionDto {
  id!: string;
  optionRef!: string | null;
  text!: string;
  position!: number;
}

/**
 * Student-only lifecycle receipt. It is intentionally narrower than the
 * teacher LiveSessionDto: no session code, questions, results, counts, or
 * watermark. All four lifecycle states return 200 so an enrolled student can
 * observe a terminal session even after archive anonymization.
 */
export class StudentLiveSessionStatusDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['waiting', 'active', 'closed', 'cancelled'] })
  status!: string;

  @ApiProperty({ nullable: true, type: String })
  startedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  closedAt!: string | null;
}

export class SessionQuestionDto {
  id!: string;
  liveSessionId!: string;
  questionDefinitionId!: string | null;
  position!: number;
  status!: string;
  snapshotType!: string;
  snapshotPrompt!: string;
  snapshotSelectionMode!: string | null;
  openedAt!: string | null;
  closedAt!: string | null;
  hasSubmitted?: boolean;
  options!: SessionQuestionOptionDto[];
}
