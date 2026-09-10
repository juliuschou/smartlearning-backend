import { GovernanceService } from './governance.service';

type GovernanceInternals = {
  purgeOneInTransaction: (...args: unknown[]) => Promise<unknown>;
};

describe('GovernanceService', () => {
  const archive = (id: string, purgeAt: Date) => ({
    id: `archive-${id}`,
    liveSessionId: id,
    courseId: 'course-1',
    sessionLabel: '2026-01-01T00:00:00.000Z',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    closedAt: new Date('2026-01-01T00:00:00.000Z'),
    purgeAt,
    status: 'active',
    payload: { schemaVersion: 1, questions: [] },
    course: { id: 'course-1', name: 'Course' },
    deletionEvents: [],
  });
  const serviceWithClaims = (
    claims: Array<Array<{ liveSessionId: string }>>,
    metrics?: object,
  ) => {
    const queryRaw = jest.fn();
    for (const claim of claims) queryRaw.mockResolvedValueOnce(claim);
    queryRaw.mockResolvedValue([]);
    const tx = {
      run: jest.fn((fn: (t: unknown) => unknown) =>
        fn({ $queryRaw: queryRaw }),
      ),
    };
    const service = new GovernanceService(
      { prisma: {} } as never,
      tx as never,
      metrics as never,
    );
    return { service, queryRaw };
  };

  it('claims due sessions oldest first with a bounded limit and stable now', async () => {
    const { service } = serviceWithClaims([
      [{ liveSessionId: 'older' }],
      [{ liveSessionId: 'newer' }],
    ]);
    const purgeOneInTransaction = jest
      .spyOn(service as unknown as GovernanceInternals, 'purgeOneInTransaction')
      .mockResolvedValue({ status: 'deleted' } as never);
    const now = new Date('2026-02-01T00:00:00.000Z');

    await expect(service.purgeDue(1000, now)).resolves.toEqual({
      selected: 2,
      deleted: 2,
      failed: 0,
    });
    expect(
      purgeOneInTransaction.mock.calls.map((call) => call.slice(1)),
    ).toEqual([
      ['older', 'retention', undefined, 'retention', now],
      ['newer', 'retention', undefined, 'retention', now],
    ]);
  });

  it('continues after a failed item and excludes its id from later claims', async () => {
    const metrics = { recordJobItem: jest.fn(), recordJobRun: jest.fn() };
    const { service, queryRaw } = serviceWithClaims(
      [[{ liveSessionId: 'failed' }], [{ liveSessionId: 'continued' }]],
      metrics,
    );
    jest
      .spyOn(service as unknown as GovernanceInternals, 'purgeOneInTransaction')
      .mockRejectedValueOnce(new Error('purge sentinel'))
      .mockResolvedValue({ status: 'deleted' } as never);

    await expect(
      service.purgeDue(3, new Date('2026-02-01T00:00:00.000Z')),
    ).resolves.toEqual({ selected: 2, deleted: 1, failed: 1 });
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(metrics.recordJobItem).toHaveBeenCalledWith(
      'retention_purge',
      'failed',
      1,
    );
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

  it('rejects a mismatched confirmation reason before destructive writes', async () => {
    const destructiveMocks = [
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
    ];
    const transaction = {
      archivedResult: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'archive-1',
          liveSessionId: 'session-1',
          status: 'active',
        }),
        update: destructiveMocks[0],
      },
      deletionEvent: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'request-1',
          reason: 'privacy',
          resolvedByEvent: null,
        }),
        create: destructiveMocks[1],
        update: destructiveMocks[2],
      },
      submission: { deleteMany: destructiveMocks[3] },
      sessionQuestion: { deleteMany: destructiveMocks[4] },
      deletionManifestOutbox: { create: destructiveMocks[5] },
    };
    const service = new GovernanceService({ prisma: {} } as never, {} as never);

    await expect(
      (service as unknown as GovernanceInternals).purgeOneInTransaction(
        transaction,
        'session-1',
        'early_delete',
        'admin-1',
        'support',
        new Date('2026-02-01T00:00:00.000Z'),
        'request-1',
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', field: 'reason' });
    for (const mock of destructiveMocks) expect(mock).not.toHaveBeenCalled();
  });

  it('returns only a matching canonical replay and rejects a conflicting one', async () => {
    const resolvedByEvent = {
      id: 'deletion-1',
      trigger: 'early_delete',
      reason: 'privacy',
      status: 'success',
      completedAt: new Date('2026-02-01T00:00:00.000Z'),
    };
    const transaction = {
      archivedResult: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'archive-1',
          liveSessionId: 'session-1',
          status: 'deleted',
        }),
      },
      deletionEvent: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'request-1',
          reason: 'privacy',
          resolvedByEvent,
        }),
      },
    };
    const service = new GovernanceService({ prisma: {} } as never, {} as never);
    const purge = (reason: 'privacy' | 'support') =>
      (service as unknown as GovernanceInternals).purgeOneInTransaction(
        transaction,
        'session-1',
        'early_delete',
        'admin-1',
        reason,
        new Date('2026-02-02T00:00:00.000Z'),
        'request-1',
      );

    await expect(purge('privacy')).resolves.toEqual({
      archiveId: 'archive-1',
      liveSessionId: 'session-1',
      deletionRequestId: 'request-1',
      status: 'deleted',
      deletion: {
        trigger: 'early_delete',
        reason: 'privacy',
        deletedAt: '2026-02-01T00:00:00.000Z',
      },
    });
    await expect(purge('support')).rejects.toMatchObject({
      code: 'CONFLICT',
      field: 'reason',
    });
  });
});
