import { GovernanceService } from './governance.service';

describe('GovernanceService', () => {
  const archive = (id: string, purgeAt: Date) => ({
    id: `archive-${id}`,
    liveSessionId: id,
    courseId: 'course-1',
    closedAt: new Date('2026-01-01T00:00:00.000Z'),
    purgeAt,
    status: 'active',
  });

  it('clamps purge batches and processes due archives oldest first', async () => {
    const rows = [
      archive('older', new Date('2026-01-01T00:00:00.000Z')),
      archive('newer', new Date('2026-01-02T00:00:00.000Z')),
    ];
    const service = new GovernanceService(
      {
        prisma: {
          archivedResult: {
            findMany: jest.fn().mockResolvedValue(rows),
          },
        },
      } as never,
      {} as never,
    );
    const purgeOne = jest
      .spyOn(service, 'purgeOne')
      .mockResolvedValue({ status: 'success' });

    await expect(
      service.purgeDue(1000, new Date('2026-02-01T00:00:00.000Z')),
    ).resolves.toEqual({ selected: 2, deleted: 2 });
    expect(purgeOne).toHaveBeenNthCalledWith(
      1,
      'older',
      'retention',
      undefined,
      'retention',
      new Date('2026-02-01T00:00:00.000Z'),
    );
  });

  it('records retention selection, deletion, and successful run metrics', async () => {
    const metrics = {
      recordJobItem: jest.fn(),
      recordJobRun: jest.fn(),
    };
    const service = new GovernanceService(
      {
        prisma: {
          archivedResult: {
            findMany: jest
              .fn()
              .mockResolvedValue([
                archive('session-1', new Date('2026-01-01T00:00:00.000Z')),
              ]),
          },
        },
      } as never,
      {} as never,
      metrics as never,
    );
    jest.spyOn(service, 'purgeOne').mockResolvedValue({ status: 'success' });

    await service.purgeDue(1, new Date('2026-02-01T00:00:00.000Z'));

    expect(metrics.recordJobItem).toHaveBeenNthCalledWith(
      1,
      'retention_purge',
      'selected',
      1,
    );
    expect(metrics.recordJobItem).toHaveBeenNthCalledWith(
      2,
      'retention_purge',
      'deleted',
      1,
    );
    expect(metrics.recordJobRun).toHaveBeenCalledWith(
      'retention_purge',
      'success',
      expect.any(Number),
    );
  });

  it('records retention failure and rethrows the original purge error', async () => {
    const original = new Error('purge sentinel');
    const metrics = {
      recordJobItem: jest.fn(),
      recordJobRun: jest.fn(),
    };
    const service = new GovernanceService(
      {
        prisma: {
          archivedResult: {
            findMany: jest
              .fn()
              .mockResolvedValue([
                archive('session-1', new Date('2026-01-01T00:00:00.000Z')),
              ]),
          },
        },
      } as never,
      {} as never,
      metrics as never,
    );
    jest.spyOn(service, 'purgeOne').mockRejectedValue(original);

    await expect(
      service.purgeDue(1, new Date('2026-02-01T00:00:00.000Z')),
    ).rejects.toBe(original);
    expect(metrics.recordJobRun).toHaveBeenCalledWith(
      'retention_purge',
      'failure',
      expect.any(Number),
    );
  });

  it('returns a paginated owner-scoped archive page', async () => {
    const rows = [archive('session-1', new Date('2026-04-01T00:00:00.000Z'))];
    const findMany = jest.fn().mockResolvedValue(rows);
    const count = jest.fn().mockResolvedValue(3);
    const service = new GovernanceService(
      { prisma: { archivedResult: { findMany, count } } } as never,
      {} as never,
    );

    await expect(
      service.list(
        { id: 'teacher-1', role: 'teacher' },
        { page: 2, pageSize: 1 },
      ),
    ).resolves.toMatchObject({
      data: [{ liveSessionId: 'session-1' }],
      meta: { page: 2, pageSize: 1, total: 3, totalPages: 3 },
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 1, take: 1 }),
    );
    expect(findMany.mock.calls[0][0].where).toEqual({
      course: { ownerAccountId: 'teacher-1' },
    });
  });
});
