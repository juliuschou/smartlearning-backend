import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { PermissionSummaryService } from './permission-summary.service';

@Module({
  imports: [PrismaModule],
  providers: [PermissionSummaryService],
  exports: [PermissionSummaryService],
})
export class PermissionsModule {}
