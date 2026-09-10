import {
  DELETION_MANIFEST_VERSION,
  parseDeletionManifest,
} from './deletion-manifest';

describe('parseDeletionManifest', () => {
  it('normalizes and validates the versioned contract', () => {
    expect(
      parseDeletionManifest({
        contractVersion: DELETION_MANIFEST_VERSION,
        deletionEventId: '0198c37c-8a2f-7dd1-b2e4-3af6f4c1d001',
        archivedResultId: '0198c37c-8a2f-7dd1-b2e4-3af6f4c1d002',
        liveSessionId: '0198c37c-8a2f-7dd1-b2e4-3af6f4c1d003',
        trigger: 'retention',
        reason: 'retention',
        deletedAt: '2026-09-09T00:00:00.000Z',
        categories: ['b', 'a'],
      }),
    ).toEqual({
      contractVersion: DELETION_MANIFEST_VERSION,
      deletionEventId: '0198c37c-8a2f-7dd1-b2e4-3af6f4c1d001',
      archivedResultId: '0198c37c-8a2f-7dd1-b2e4-3af6f4c1d002',
      liveSessionId: '0198c37c-8a2f-7dd1-b2e4-3af6f4c1d003',
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
    {
      contractVersion: DELETION_MANIFEST_VERSION,
      deletionEventId: 'not-a-uuid',
      archivedResultId: '0198c37c-8a2f-7dd1-b2e4-3af6f4c1d002',
      liveSessionId: '0198c37c-8a2f-7dd1-b2e4-3af6f4c1d003',
      trigger: 'retention',
      reason: 'retention',
      deletedAt: '2026-09-09T00:00:00.000Z',
      categories: [],
    },
  ])('rejects malformed manifests: %j', (value) => {
    expect(() => parseDeletionManifest(value)).toThrow(
      'Invalid deletion manifest',
    );
  });
});
