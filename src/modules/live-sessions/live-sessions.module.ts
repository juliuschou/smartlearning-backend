import { Module } from '@nestjs/common';
import { QuestionsModule } from '../questions/questions.module';
import { GovernanceModule } from '../governance/governance.module';
import { LiveSessionsController } from './api/live-sessions.controller';
import { LiveSessionService } from './application/live-session.service';
import { LiveSessionAutoCloseScheduler } from './application/live-session-auto-close.scheduler';

@Module({
  imports: [QuestionsModule, GovernanceModule],
  controllers: [LiveSessionsController],
  providers: [LiveSessionService, LiveSessionAutoCloseScheduler],
  exports: [LiveSessionService],
})
export class LiveSessionsModule {}
