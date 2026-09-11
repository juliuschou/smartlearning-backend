import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { newId } from '../../../common/crypto/uuid';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  InvalidDeletionManifestError,
  parseDeletionManifest,
  type DeletionManifest,
} from '../domain/deletion-manifest';

export const DELETION_MANIFEST_PROVIDER = Symbol('DELETION_MANIFEST_PROVIDER');

export interface DeletionManifestProvider {
  put(manifest: DeletionManifest): Promise<void>;
}

/** Controlled local provider: immutable per deletion event, no network or credentials. */
@Injectable()
export class LocalImmutableManifestProvider implements DeletionManifestProvider {
  readonly manifests = new Map<string, DeletionManifest>();
  failNext = false;

  async put(manifest: DeletionManifest): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('controlled local provider failure');
    }
    const existing = this.manifests.get(manifest.deletionEventId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
        throw new TypeError('immutable manifest conflict');
      }
      return;
    }
    this.manifests.set(manifest.deletionEventId, structuredClone(manifest));
  }
}

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;

type OutboxRow = {
  id: string;
  manifest: unknown;
  attempts: number;
  leaseToken: string;
};

@Injectable()
export class DeletionManifestExporter {
  private readonly logger = new Logger(DeletionManifestExporter.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DELETION_MANIFEST_PROVIDER)
    private readonly provider: DeletionManifestProvider,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async exportDueBatch(
    max = 50,
    now = new Date(),
  ): Promise<{ selected: number; exported: number; failed: number }> {
    const startedAt = process.hrtime.bigint();
    const leaseToken = newId();
    const rows = await this.claimDueRows(
      Math.max(1, Math.min(100, Math.floor(max))),
      now,
      leaseToken,
    );
    this.recordItem('selected', rows.length);
    let exported = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        let parsed: DeletionManifest;
        try {
          parsed = parseDeletionManifest(row.manifest);
        } catch (error) {
          failed += Number(
            await this.markFailure(
              row,
              error,
              now,
              error instanceof InvalidDeletionManifestError,
            ),
          );
          continue;
        }
        await this.provider.put(parsed);
        const result =
          await this.prisma.prisma.deletionManifestOutbox.updateMany({
            where: {
              id: row.id,
              status: 'processing',
              leaseToken: row.leaseToken,
            },
            data: {
              status: 'exported',
              exportedAt: now,
              leaseToken: null,
              leaseExpiresAt: null,
              lastError: null,
            },
          });
        if (result.count === 1) exported++;
      } catch (error) {
        failed += Number(await this.markFailure(row, error, now));
      }
    }
    this.recordItem('exported', exported);
    this.recordItem('failed', failed);
    this.recordRun(failed === 0 ? 'success' : 'failure', startedAt);
    return { selected: rows.length, exported, failed };
  }

  private recordItem(
    result: 'selected' | 'exported' | 'failed',
    count: number,
  ): void {
    if (!Number.isFinite(count) || count <= 0) return;
    try {
      this.metrics?.recordJobItem('manifest_export', result, count);
    } catch {
      // Metrics must not replace manifest export results.
    }
  }

  private recordRun(outcome: 'success' | 'failure', startedAt: bigint): void {
    const durationSeconds =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    try {
      this.metrics?.recordJobRun('manifest_export', outcome, durationSeconds);
    } catch {
      // Metrics are observational and cannot change export semantics.
    }
  }

  private async claimDueRows(
    limit: number,
    now: Date,
    leaseToken: string,
  ): Promise<OutboxRow[]> {
    return this.prisma.prisma.$transaction(
      async (tx) => tx.$queryRaw<OutboxRow[]>`
      WITH eligible AS (
        SELECT id FROM deletion_manifest_outbox
        WHERE ((status IN ('pending','retry') AND next_attempt_at <= ${now})
          OR (status = 'processing' AND lease_expires_at <= ${now}))
        ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT ${limit}
      )
      UPDATE deletion_manifest_outbox o
      SET status = 'processing', attempts = o.attempts + 1,
          lease_token = ${leaseToken}::uuid,
          lease_expires_at = ${new Date(now.getTime() + LEASE_MS)}
      FROM eligible WHERE o.id = eligible.id
      RETURNING o.id, o.manifest, o.attempts, o.lease_token AS "leaseToken"
    `,
    );
  }

  private async markFailure(
    row: OutboxRow,
    error: unknown,
    now: Date,
    permanent = false,
  ): Promise<boolean> {
    const dead = row.attempts >= MAX_ATTEMPTS || permanent;
    const backoff = Math.min(
      MAX_BACKOFF_MS,
      INITIAL_BACKOFF_MS * 2 ** Math.max(0, row.attempts - 1),
    );
    const result = await this.prisma.prisma.deletionManifestOutbox.updateMany({
      where: { id: row.id, status: 'processing', leaseToken: row.leaseToken },
      data: {
        status: dead ? 'failed' : 'retry',
        nextAttemptAt: new Date(now.getTime() + (dead ? 0 : backoff)),
        lastError:
          error instanceof Error ? error.message.slice(0, 500) : 'unknown',
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    if (result.count)
      this.logger.warn(
        { outboxId: row.id, status: dead ? 'failed' : 'retry' },
        'Deletion manifest export failed',
      );
    return result.count === 1;
  }
}
