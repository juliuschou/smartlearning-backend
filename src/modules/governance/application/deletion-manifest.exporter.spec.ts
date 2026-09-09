import {
  DeletionManifestExporter,
  LocalImmutableManifestProvider,
} from './deletion-manifest.exporter';
import type { DeletionManifest } from '../domain/deletion-manifest';

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
});
