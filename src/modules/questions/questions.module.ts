import { Module } from '@nestjs/common';
import { QuestionsController } from './api/questions.controller';
import { QuestionService } from './application/question.service';

@Module({
  controllers: [QuestionsController],
  providers: [QuestionService],
  exports: [QuestionService],
})
export class QuestionsModule {}
