import { Module } from '@nestjs/common';
import { QuestionsModule } from '../questions/questions.module';
import { LiveSessionsController } from './api/live-sessions.controller';
import { LiveSessionService } from './application/live-session.service';

@Module({
  imports: [QuestionsModule],
  controllers: [LiveSessionsController],
  providers: [LiveSessionService],
  exports: [LiveSessionService],
})
export class LiveSessionsModule {}
