import { Module } from '@nestjs/common';
import {
  GovernanceController,
  AdminGovernanceController,
} from './api/governance.controller';
import { GovernanceService } from './application/governance.service';
import { RetentionScheduler } from './application/retention.scheduler';
import { ManifestExportScheduler } from './application/manifest-export.scheduler';
import { ConfigService } from '@nestjs/config';
import {
  DELETION_MANIFEST_PROVIDER,
  DeletionManifestExporter,
  LocalImmutableManifestProvider,
} from './application/deletion-manifest.exporter';
import { S3ManifestProvider } from './application/s3-manifest.provider';
@Module({
  controllers: [GovernanceController, AdminGovernanceController],
  providers: [
    GovernanceService,
    RetentionScheduler,
    ManifestExportScheduler,
    LocalImmutableManifestProvider,
    DeletionManifestExporter,
    {
      provide: DELETION_MANIFEST_PROVIDER,
      inject: [ConfigService, LocalImmutableManifestProvider],
      useFactory: (
        config: ConfigService,
        local: LocalImmutableManifestProvider,
      ) =>
        config.get('DELETION_MANIFEST_PROVIDER') === 's3'
          ? new S3ManifestProvider(config)
          : local,
    },
  ],
  exports: [
    GovernanceService,
    DeletionManifestExporter,
    LocalImmutableManifestProvider,
  ],
})
export class GovernanceModule {}
