import { Module } from '@nestjs/common';
import {
  GovernanceController,
  AdminGovernanceController,
} from './api/governance.controller';
import { GovernanceService } from './application/governance.service';
import { RetentionScheduler } from './application/retention.scheduler';
import {
  DELETION_MANIFEST_PROVIDER,
  DeletionManifestExporter,
  LocalImmutableManifestProvider,
} from './application/deletion-manifest.exporter';
@Module({
  controllers: [GovernanceController, AdminGovernanceController],
  providers: [
    GovernanceService,
    RetentionScheduler,
    LocalImmutableManifestProvider,
    DeletionManifestExporter,
    {
      provide: DELETION_MANIFEST_PROVIDER,
      useExisting: LocalImmutableManifestProvider,
    },
  ],
  exports: [
    GovernanceService,
    DeletionManifestExporter,
    LocalImmutableManifestProvider,
  ],
})
export class GovernanceModule {}
