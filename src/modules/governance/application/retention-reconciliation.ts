import {
  parseDeletionManifest,
  type DeletionManifest,
} from '../domain/deletion-manifest';

export type ManifestWatermark = { deletedAt: string; deletionEventId: string };
export type ReconciliationItem = {
  manifest: DeletionManifest;
  local: boolean;
  watermarkEligible: boolean;
};

export interface LocalManifestProvider {
  list(): Promise<unknown[]>;
  watermark(): Promise<unknown | undefined>;
  saveWatermark?(watermark: ManifestWatermark): Promise<void>;
  applyManifest(manifest: DeletionManifest): Promise<void>;
}

export function parseManifestWatermark(value: unknown): ManifestWatermark {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid manifest watermark');
  const v = value as Record<string, unknown>;
  if (
    typeof v.deletionEventId !== 'string' ||
    typeof v.deletedAt !== 'string'
  ) {
    throw new Error('Invalid manifest watermark');
  }
  const date = new Date(v.deletedAt);
  if (Number.isNaN(date.getTime()))
    throw new Error('Invalid manifest watermark');
  return { deletionEventId: v.deletionEventId, deletedAt: date.toISOString() };
}

export class RetentionReconciliationService {
  constructor(private readonly provider: LocalManifestProvider) {}

  async inspect(): Promise<{
    valid: number;
    invalid: number;
    watermark?: ManifestWatermark;
    items: ReconciliationItem[];
  }> {
    const [rows, rawWatermark] = await Promise.all([
      this.provider.list(),
      this.provider.watermark(),
    ]);
    const watermark =
      rawWatermark === undefined
        ? undefined
        : parseManifestWatermark(rawWatermark);
    const items: ReconciliationItem[] = [];
    let invalid = 0;
    for (const row of rows) {
      try {
        const manifest = parseDeletionManifest(row);
        items.push({
          manifest,
          local: true,
          watermarkEligible:
            !watermark ||
            manifest.deletedAt > watermark.deletedAt ||
            (manifest.deletedAt === watermark.deletedAt &&
              manifest.deletionEventId > watermark.deletionEventId),
        });
      } catch {
        invalid++;
      }
    }
    return { valid: items.length, invalid, watermark, items };
  }

  async apply(): Promise<{ applied: number; skipped: number }> {
    if (!this.provider.saveWatermark)
      throw new Error('Local watermark writer is not configured');
    if (!this.provider.applyManifest)
      throw new Error('DB manifest applier is not configured');
    const report = await this.inspect();
    // Applying a manifest is a state-changing operation.  Never advance the
    // watermark when even one input is malformed: a partial apply could make
    // an untrusted/omitted deletion permanently unreconcilable.
    if (report.invalid > 0)
      throw new Error('Manifest apply refused: invalid manifest');
    const ids = new Set<string>();
    for (const item of report.items) {
      if (ids.has(item.manifest.deletionEventId))
        throw new Error('Manifest apply refused: duplicate deletion event');
      ids.add(item.manifest.deletionEventId);
    }
    const eligible = report.items.filter((item) => item.watermarkEligible);
    if (eligible.length === 0)
      return { applied: 0, skipped: report.items.length };
    for (const item of eligible)
      await this.provider.applyManifest(item.manifest);
    const latest = eligible
      .slice()
      .sort(
        (a, b) =>
          a.manifest.deletedAt.localeCompare(b.manifest.deletedAt) ||
          a.manifest.deletionEventId.localeCompare(b.manifest.deletionEventId),
      )
      .at(-1)!;
    await this.provider.saveWatermark({
      deletedAt: latest.manifest.deletedAt,
      deletionEventId: latest.manifest.deletionEventId,
    });
    return {
      applied: eligible.length,
      skipped: report.items.length - eligible.length,
    };
  }
}
