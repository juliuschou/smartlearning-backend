import { normalizeUuid } from '../../../../common/crypto';
import { ApiProperty } from '@nestjs/swagger';
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
  questionSelections?: Array<{
    questionDefinitionId: string;
    position: number;
  }>;
  sessionQuestions?: SessionQuestionDto[];
}

export class SessionQuestionOptionDto {
  id!: string;
  optionRef!: string | null;
  text!: string;
  position!: number;
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
