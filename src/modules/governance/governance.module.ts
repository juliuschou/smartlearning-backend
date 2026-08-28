import { Module } from '@nestjs/common';
import {
  GovernanceController,
  AdminGovernanceController,
} from './api/governance.controller';
import { GovernanceService } from './application/governance.service';
@Module({
  controllers: [GovernanceController, AdminGovernanceController],
  providers: [GovernanceService],
  exports: [GovernanceService],
})
export class GovernanceModule {}
