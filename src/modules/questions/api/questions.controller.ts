import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CsrfGuard, CurrentAccount, SessionGuard } from '../../../common/auth';
import type { AuthContext } from '../../../common/auth';
import { type Page } from '../../../common/pagination';
import {
  QuestionService,
  toQuestionDto,
} from '../application/question.service';
import {
  CreateQuestionDto,
  ReorderQuestionsDto,
  UpdateQuestionDto,
  type QuestionDto,
} from './dto';

@ApiTags('questions')
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

  @Get(':courseId/questions')
  @UseGuards(SessionGuard)
  async list(
    @Param('courseId', new ParseUUIDPipe()) courseId: string,
    @CurrentAccount() auth: AuthContext,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<Page<QuestionDto>> {
    const result = await this.questions.listQuestions(
      courseId,
      { id: auth.account.id, role: auth.account.role },
      {
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
      },
    );
    return {
      data: result.data.map(toQuestionDto),
      meta: result.meta,
    };
  }

  @Get(':courseId/questions/:id')
  @UseGuards(SessionGuard)
  async detail(
    @Param('courseId', new ParseUUIDPipe()) courseId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<QuestionDto> {
    const question = await this.questions.getQuestion(courseId, id, {
      id: auth.account.id,
      role: auth.account.role,
    });
    return toQuestionDto(question);
  }

  @Patch(':courseId/questions/order')
  @UseGuards(SessionGuard, CsrfGuard)
  async reorder(
    @Param('courseId', new ParseUUIDPipe()) courseId: string,
    @Body() dto: ReorderQuestionsDto,
    @CurrentAccount() auth: AuthContext,
  ): Promise<Page<QuestionDto>> {
    const questions = await this.questions.reorderQuestions(
      courseId,
      { id: auth.account.id, role: auth.account.role },
      dto.questionIds,
    );
    return {
      data: questions.map(toQuestionDto),
      meta: {
        page: 1,
        pageSize: questions.length,
        total: questions.length,
        totalPages: questions.length === 0 ? 0 : 1,
      },
    };
  }

  @Patch(':courseId/questions/:id')
  @UseGuards(SessionGuard, CsrfGuard)
  async update(
    @Param('courseId', new ParseUUIDPipe()) courseId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateQuestionDto,
    @CurrentAccount() auth: AuthContext,
  ): Promise<QuestionDto> {
    const question = await this.questions.updateQuestion(
      courseId,
      id,
      { id: auth.account.id, role: auth.account.role },
      dto,
    );
    return toQuestionDto(question);
  }

  @Delete(':courseId/questions/:id')
  @UseGuards(SessionGuard, CsrfGuard)
  async remove(
    @Param('courseId', new ParseUUIDPipe()) courseId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentAccount() auth: AuthContext,
  ): Promise<null> {
    await this.questions.deleteQuestion(courseId, id, {
      id: auth.account.id,
      role: auth.account.role,
    });
    return null;
  }
}
