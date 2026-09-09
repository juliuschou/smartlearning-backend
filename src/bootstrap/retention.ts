import { readFile, writeFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { GovernanceService } from '../modules/governance/application/governance.service';
import { TransactionService } from '../prisma/transaction.service';
import {
  RetentionReconciliationService,
  type LocalManifestProvider,
} from '../modules/governance/application/retention-reconciliation';

export type RetentionCommand =
  | 'inspect'
  | 'run-once'
  | 'manifest-export-once'
  | 'reconcile-inspect'
  | 'reconcile-apply';

export function parseRetentionCommand(argv: string[]): RetentionCommand {
  const command = argv[2] ?? 'inspect';
  if (
    [
      'inspect',
      'run-once',
      'manifest-export-once',
      'reconcile-inspect',
      'reconcile-apply',
    ].includes(command)
  )
    return command as RetentionCommand;
  throw new Error(`Unknown retention command: ${command}`);
}

function enabled(name: string): boolean {
  return process.env[name] === '1' || process.env[name] === 'true';
}
function requireGate(name: string): void {
  if (!enabled(name)) throw new Error(`${name} must be explicitly enabled`);
}
function localPath(): string {
  const path = process.env.RETENTION_LOCAL_MANIFEST_FILE;
  if (!path) throw new Error('RETENTION_LOCAL_MANIFEST_FILE is required');
  return path;
}

async function localProvider(
  path: string,
  applyManifest?: LocalManifestProvider['applyManifest'],
): Promise<LocalManifestProvider> {
  const read = async (): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  };
  return {
    async list() {
      const value = await read();
      if (value.manifests === undefined) return [];
      if (!Array.isArray(value.manifests))
        throw new Error('Invalid local manifest store');
      return value.manifests;
    },
    async watermark() {
      return (await read()).watermark;
    },
    async saveWatermark(watermark) {
      const value = await read();
      await writeFile(
        path,
        JSON.stringify({ ...value, watermark }, null, 2) + '\n',
        'utf8',
      );
    },
    applyManifest:
      applyManifest ??
      (async () => {
        throw new Error('DB manifest applier is not configured');
      }),
  };
}

async function main(): Promise<void> {
  const command = parseRetentionCommand(process.argv);
  requireGate('RETENTION_OPERATIONS_ENABLED');
  if (command === 'reconcile-apply')
    requireGate('RETENTION_RECONCILE_APPLY_ENABLED');
  if (command === 'reconcile-inspect') {
    const service = new RetentionReconciliationService(
      await localProvider(localPath()),
    );
    console.log(JSON.stringify(await service.inspect()));
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const governance = app.get(GovernanceService);
    if (command === 'reconcile-apply') {
      const tx = app.get(TransactionService);
      const service = new RetentionReconciliationService(
        await localProvider(localPath(), async (manifest) => {
          await tx.run(async (t) => {
            await tx.lockLiveSessionForUpdate(t, manifest.liveSessionId);
            await governance.applyDeletionManifestInTransaction(t, manifest);
          });
        }),
      );
      console.log(JSON.stringify(await service.apply()));
    } else if (command === 'inspect')
      console.log(JSON.stringify(await governance.inspectDue()));
    else if (command === 'run-once') {
      requireGate('RETENTION_PURGE_ENABLED');
      console.log(
        JSON.stringify({
          executed: false,
          reason:
            'DB-mutating retention run is intentionally not wired into this local-only command',
        }),
      );
    } else {
      requireGate('RETENTION_MANIFEST_EXPORT_ENABLED');
      console.log(
        JSON.stringify({
          executed: false,
          reason:
            'External manifest export is intentionally not wired into this local-only command',
        }),
      );
    }
  } finally {
    await app.close();
  }
}

if (require.main === module)
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'retention command failed',
    );
    process.exitCode = 1;
  });
