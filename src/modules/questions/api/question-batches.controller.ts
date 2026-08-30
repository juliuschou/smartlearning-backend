import {
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { OperationRateLimitGuard } from '../../rate-limit/operation-rate-limit.guard';
import {
  OperationRateLimit,
  OperationRateLimitPolicy,
} from '../../rate-limit/operation-rate-limit';
import {
  BatchActorGuard,
  BatchCsrfGuard,
  CurrentBatchActor,
} from '../../../common/auth';
import type { BatchActorContext } from '../../../common/auth';
import { QuestionBatchService } from '../application/question-batch.service';
import type {
  ValidateBatchResult,
  ConfirmBatchResult,
} from '../application/question-batch.service';
import { ConfirmQuestionBatchDto, ValidateQuestionBatchDto } from './dto';

const VALIDATION_TOKEN_HEADER = 'x-validation-token';

/**
 * Batch question validate/confirm under /api/v1/courses/:courseId/question-batches.
 *
 * Actor: Web teacher (cookie session + CSRF) or CLI actor (X-CLI-Key, no CSRF).
 * Confirm additionally requires an Idempotency-Key header (UUID) and the
 * X-Validation-Token returned by validate.
 *
 * The `@Body` pipe overrides the global ValidationPipe: the global pipe uses
 * `forbidNonWhitelisted: true`, which (combined with nested `@ValidateNested`
 * array transforms) mangles the `questions` payload in e2e. Here we only
 * transform DTOs and skip whitelisting/forbidding, delegating per-question
 * contract validation to the domain layer (`validateBatch` → `validateQuestion`).
 */
@ApiTags('question-batches')
@ApiHeader({
  name: 'X-CLI-Key',
  required: false,
  description:
    'CLI credential alternative to a Web session. If supplied, invalid credentials do not fall back to cookies.',
})
@Controller({ path: 'courses', version: '1' })
export class QuestionBatchesController {
  constructor(private readonly batches: QuestionBatchService) {}

  @Post(':courseId/question-batches/validate')
  @OperationRateLimit(OperationRateLimitPolicy.CLI_BATCH_VALIDATE)
  @UseGuards(BatchActorGuard, OperationRateLimitGuard, BatchCsrfGuard)
  async validate(
    @Param('courseId', new ParseUUIDPipe()) courseId: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: false,
        forbidNonWhitelisted: false,
      }),
    )
    dto: ValidateQuestionBatchDto,
    @CurrentBatchActor() actor: BatchActorContext,
  ): Promise<ValidateBatchResult> {
    return this.batches.validateBatch(courseId, this.toCaller(actor), {
      schemaVersion: dto.schemaVersion,
      questions: dto.questions,
    });
  }

  @Post(':courseId/question-batches/confirm')
  @OperationRateLimit(OperationRateLimitPolicy.CLI_BATCH_CONFIRM)
  @UseGuards(BatchActorGuard, OperationRateLimitGuard, BatchCsrfGuard)
  async confirm(
    @Param('courseId', new ParseUUIDPipe()) courseId: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: false,
        forbidNonWhitelisted: false,
      }),
    )
    dto: ConfirmQuestionBatchDto,
    @CurrentBatchActor() actor: BatchActorContext,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers(VALIDATION_TOKEN_HEADER) validationToken?: string,
  ): Promise<ConfirmBatchResult> {
    return this.batches.confirmBatch(
      courseId,
      this.toCaller(actor),
      {
        schemaVersion: dto.schemaVersion,
        questions: dto.questions,
        payloadHash: dto.payloadHash,
        confirmed: dto.confirmed,
      },
      validationToken,
      idempotencyKey,
    );
  }

  private toCaller(
    actor: BatchActorContext,
  ): Parameters<QuestionBatchService['validateBatch']>[1] {
    return {
      kind: actor.kind,
      accountId: actor.accountId,
      role: actor.role,
      cliCredentialId: actor.cliCredentialId,
    };
  }
}
