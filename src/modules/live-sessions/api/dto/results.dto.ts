import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Results projection for a single SessionQuestion.
 *
 * Discriminated by `snapshotType`. Teacher projection always carries
 * `isCorrect` for quiz; participant projection reveals `isCorrect` only after
 * the question is closed (vote-to-reveal, US-F17).
 *
 * Aggregation is derived on-the-fly from committed Submission rows (no
 * Aggregate/VoteCount authority). See M2 即時同步與結果治理設計.
 */

/** Per-option count shared by poll and quiz results. */
export class OptionCountDto {
  @ApiProperty({ description: 'SessionQuestionOption.id (formal option UUID)' })
  optionId!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  optionRef!: string | null;

  @ApiProperty()
  text!: string;

  @ApiProperty({ description: 'Number of submissions selecting this option.' })
  count!: number;

  @ApiPropertyOptional({
    description:
      'Present for quiz only; omitted for poll/open_text. Participant sees it only after close.',
  })
  isCorrect?: boolean;
}

export class PollResultsDto {
  @ApiProperty({ enum: ['poll'] })
  snapshotType!: 'poll';

  @ApiProperty({ enum: ['single', 'multiple'] })
  selectionMode!: 'single' | 'multiple';

  @ApiProperty({ enum: ['open', 'closed'] })
  status!: 'open' | 'closed';

  @ApiProperty({ type: () => OptionCountDto, isArray: true })
  options!: OptionCountDto[];

  @ApiProperty({
    description:
      'Number of submissions. For multiple-selection polls, the sum of option counts may exceed this.',
  })
  totalResponses!: number;
}

export class QuizResultsDto {
  @ApiProperty({ enum: ['quiz'] })
  snapshotType!: 'quiz';

  @ApiProperty({ enum: ['open', 'closed'] })
  status!: 'open' | 'closed';

  @ApiProperty({ type: () => OptionCountDto, isArray: true })
  options!: OptionCountDto[];

  @ApiProperty()
  totalResponses!: number;

  @ApiProperty({
    description:
      'Submissions whose selectedOptionRefs set equals the set of isCorrect options (exact-set match; no partial/weighted scoring).',
  })
  correctCount!: number;

  @ApiProperty()
  incorrectCount!: number;

  @ApiProperty({
    description:
      'correctCount / totalResponses, in [0,1]. 0 when no responses.',
  })
  correctnessRate!: number;
}

/** Anonymized open-text answer. No display name, token, or identity. */
export class OpenTextResponseDto {
  @ApiProperty()
  text!: string;
}

export class OpenTextResultsDto {
  @ApiProperty({ enum: ['open_text'] })
  snapshotType!: 'open_text';

  @ApiProperty({ enum: ['open', 'closed'] })
  status!: 'open' | 'closed';

  @ApiProperty({ type: () => OpenTextResponseDto, isArray: true })
  responses!: OpenTextResponseDto[];

  @ApiProperty()
  totalResponses!: number;
}

export type SessionQuestionResultsDto =
  PollResultsDto | QuizResultsDto | OpenTextResultsDto;
