import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CsrfGuard, CurrentAccount, SessionGuard } from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import {
  QuestionService,
  toQuestionDto,
} from '../application/question.service';
import { CreateQuestionDto, type QuestionDto } from './dto';

@Controller({ path: 'courses', version: '1' })
export class QuestionsController {
  constructor(private readonly questions: QuestionService) {}

  @Post(':courseId/questions')
  @UseGuards(SessionGuard, CsrfGuard)
  async create(
    @Param('courseId', new ParseUUIDPipe()) courseId: string,
    @Body() dto: CreateQuestionDto,
    @CurrentAccount() auth: AuthContext,
  ): Promise<QuestionDto> {
    const question = await this.questions.createQuestion(
      courseId,
      { id: auth.account.id, role: auth.account.role },
      dto,
    );
    return toQuestionDto(question);
  }
}
