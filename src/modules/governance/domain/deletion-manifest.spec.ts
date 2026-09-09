import {
  DELETION_MANIFEST_VERSION,
  parseDeletionManifest,
} from './deletion-manifest';

describe('parseDeletionManifest', () => {
  it('normalizes and validates the versioned contract', () => {
    expect(
      parseDeletionManifest({
        contractVersion: DELETION_MANIFEST_VERSION,
        deletionEventId: 'event',
        archivedResultId: 'archive',
        liveSessionId: 'session',
        trigger: 'retention',
        reason: 'retention',
        deletedAt: '2026-09-09T00:00:00.000Z',
        categories: ['b', 'a'],
      }),
    ).toEqual({
      contractVersion: DELETION_MANIFEST_VERSION,
      deletionEventId: 'event',
      archivedResultId: 'archive',
      liveSessionId: 'session',
      trigger: 'retention',
      reason: 'retention',
      deletedAt: '2026-09-09T00:00:00.000Z',
      categories: ['a', 'b'],
    });
  });

  it.each([
    null,
    {},
    { contractVersion: 'v2' },
    { contractVersion: DELETION_MANIFEST_VERSION, categories: ['ok', 1] },
  ])('rejects malformed manifests: %j', (value) => {
    expect(() => parseDeletionManifest(value)).toThrow(
      'Invalid deletion manifest',
    );
  });
});
