import {
  RetentionReconciliationService,
  parseManifestWatermark,
} from './retention-reconciliation';

const manifest = (id: string, deletedAt: string) => ({
  contractVersion: 'deletion-manifest.v1',
  deletionEventId: id,
  archivedResultId: `a-${id}`,
  liveSessionId: `s-${id}`,
  trigger: 'retention',
  reason: 'retention',
  deletedAt,
  categories: ['submissions'],
});

describe('RetentionReconciliationService', () => {
  it('rejects malformed watermarks and reports invalid manifests', async () => {
    expect(() =>
      parseManifestWatermark({ deletionEventId: 'x', deletedAt: 'bad' }),
    ).toThrow('Invalid manifest watermark');
    const service = new RetentionReconciliationService({
      list: async () => [manifest('1', '2026-01-01T00:00:00Z'), { bad: true }],
      watermark: async () => undefined,
      applyManifest: async () => undefined,
    });
    await expect(service.inspect()).resolves.toMatchObject({
      valid: 1,
      invalid: 1,
    });
  });

  it('refuses to advance the watermark when any manifest is invalid', async () => {
    const saveWatermark = jest.fn(async () => undefined);
    const service = new RetentionReconciliationService({
      list: async () => [manifest('1', '2026-01-01T00:00:00Z'), { bad: true }],
      watermark: async () => undefined,
      applyManifest: async () => undefined,
      saveWatermark,
    });
    await expect(service.apply()).rejects.toThrow('invalid manifest');
    expect(saveWatermark).not.toHaveBeenCalled();
  });

  it('refuses duplicate deletion events rather than partially applying', async () => {
    const saveWatermark = jest.fn(async () => undefined);
    const service = new RetentionReconciliationService({
      list: async () => [
        manifest('1', '2026-01-01T00:00:00Z'),
        manifest('1', '2026-01-02T00:00:00Z'),
      ],
      watermark: async () => undefined,
      applyManifest: async () => undefined,
      saveWatermark,
    });
    await expect(service.apply()).rejects.toThrow('duplicate deletion event');
    expect(saveWatermark).not.toHaveBeenCalled();
  });

  it('applies eligible manifests before advancing the watermark', async () => {
    const applyManifest = jest.fn(async () => undefined);
    const saveWatermark = jest.fn(async () => undefined);
    const service = new RetentionReconciliationService({
      list: async () => [manifest('1', '2026-01-01T00:00:00Z')],
      watermark: async () => undefined,
      applyManifest,
      saveWatermark,
    });
    await expect(service.apply()).resolves.toEqual({ applied: 1, skipped: 0 });
    expect(applyManifest).toHaveBeenCalledTimes(1);
    expect(saveWatermark).toHaveBeenCalledTimes(1);
  });

  it('does not advance the watermark when DB reconciliation fails', async () => {
    const saveWatermark = jest.fn(async () => undefined);
    const service = new RetentionReconciliationService({
      list: async () => [manifest('1', '2026-01-01T00:00:00Z')],
      watermark: async () => undefined,
      applyManifest: async () => {
        throw new Error('conflict');
      },
      saveWatermark,
    });
    await expect(service.apply()).rejects.toThrow('conflict');
    expect(saveWatermark).not.toHaveBeenCalled();
  });

  it('applies only the newest local watermark and never undeletes', async () => {
    let saved: unknown;
    const service = new RetentionReconciliationService({
      list: async () => [
        manifest('1', '2026-01-01T00:00:00Z'),
        manifest('2', '2026-01-02T00:00:00Z'),
      ],
      watermark: async () => ({
        deletionEventId: '0',
        deletedAt: '2025-12-31T00:00:00Z',
      }),
      applyManifest: async () => undefined,
      saveWatermark: async (value) => {
        saved = value;
      },
    });
    await expect(service.apply()).resolves.toEqual({ applied: 2, skipped: 0 });
    expect(saved).toEqual({
      deletionEventId: '2',
      deletedAt: '2026-01-02T00:00:00.000Z',
    });
  });
});
