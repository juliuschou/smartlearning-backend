import {
  DeletionManifestExporter,
  LocalImmutableManifestProvider,
} from './deletion-manifest.exporter';
import {
  ManifestProviderConflictError,
  ManifestProviderError,
} from './manifest-provider.errors';
import type { DeletionManifest } from '../domain/deletion-manifest';

const manifest: DeletionManifest = {
  contractVersion: 'deletion-manifest.v1',
  deletionEventId: '11111111-1111-4111-8111-111111111111',
  archivedResultId: '22222222-2222-4222-8222-222222222222',
  liveSessionId: '33333333-3333-4333-8333-333333333333',
  trigger: 'retention',
  reason: 'retention',
  deletedAt: '2026-09-09T00:00:00.000Z',
  categories: [],
};

describe('LocalImmutableManifestProvider', () => {
  it('keeps manifests immutable and idempotent', async () => {
    const provider = new LocalImmutableManifestProvider();
    const manifest: DeletionManifest = {
      contractVersion: 'deletion-manifest.v1',
      deletionEventId: 'event',
      archivedResultId: 'archive',
      liveSessionId: 'session',
      trigger: 'retention',
      reason: 'retention',
      deletedAt: '2026-09-09T00:00:00.000Z',
      categories: [],
    };
    await provider.put(manifest);
    await provider.put(manifest);
    expect(provider.manifests.get('event')).toEqual(manifest);
    await expect(
      provider.put({ ...manifest, reason: 'other' }),
    ).rejects.toThrow('immutable');
  });
});

describe('DeletionManifestExporter', () => {
  it('is constructible with the durable provider contract', () => {
    expect(DeletionManifestExporter).toBeDefined();
  });

  const row = {
    id: 'outbox-1',
    manifest,
    attempts: 1,
    leaseToken: 'lease-1',
  };

  const prismaWith = (updateMany: jest.Mock) =>
    ({
      prisma: {
        $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
          fn({ $queryRaw: jest.fn().mockResolvedValue([row]) }),
        ),
        deletionManifestOutbox: { updateMany },
      },
    }) as never;

  it('never marks a row exported when the provider is unavailable', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const provider = {
      put: jest
        .fn()
        .mockRejectedValue(new ManifestProviderError('down', 'unavailable')),
    };
    const exporter = new DeletionManifestExporter(
      prismaWith(updateMany),
      provider as never,
    );

    const result = await exporter.exportDueBatch(1, new Date());

    expect(result).toEqual({ selected: 1, exported: 0, failed: 1 });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'retry' }),
      }),
    );
    expect(updateMany.mock.calls[0][0].data.status).not.toBe('exported');
  });

  it('never marks a row exported on a provider conflict', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const provider = {
      put: jest.fn().mockRejectedValue(new ManifestProviderConflictError()),
    };
    const exporter = new DeletionManifestExporter(
      prismaWith(updateMany),
      provider as never,
    );

    const result = await exporter.exportDueBatch(1, new Date());

    expect(result).toEqual({ selected: 1, exported: 0, failed: 1 });
    expect(updateMany.mock.calls[0][0].data.status).not.toBe('exported');
  });
});
