import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { QuestionsController } from './api/questions.controller';
import { QuestionBatchesController } from './api/question-batches.controller';
import { QuestionService } from './application/question.service';
import { QuestionBatchService } from './application/question-batch.service';
import { BatchActorGuard, BatchCsrfGuard } from '../../common/auth';

/**
 * Questions bounded context: single-question CRUD/reorder + batch validate/confirm.
 *
 * Batch endpoints accept Web or CLI actors, so this module imports IdentityModule
 * to obtain CliAuthGuard/CliCredentialService and registers the composite
 * BatchActorGuard/BatchCsrfGuard locally.
 */
@Module({
  imports: [IdentityModule],
  controllers: [QuestionsController, QuestionBatchesController],
  providers: [
    QuestionService,
    QuestionBatchService,
    BatchActorGuard,
    BatchCsrfGuard,
  ],
  exports: [QuestionService, QuestionBatchService],
})
export class QuestionsModule {}
