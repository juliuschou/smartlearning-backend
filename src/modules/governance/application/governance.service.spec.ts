import { GovernanceService } from './governance.service';

type GovernanceInternals = {
  purgeOneInTransaction: (...args: unknown[]) => Promise<unknown>;
};

type GovernanceInternals2 = {
  claimDueInTransaction: (...args: unknown[]) => Promise<
    Array<{
      liveSessionId: string;
      archiveId: string;
      purgeAttempts: number;
      leaseToken: string;
    }>
  >;
  transitionFailureInTransaction: (
    t: unknown,
    archiveId: string,
    leaseToken: string,
    code: string,
    attempts: number,
    now: Date,
  ) => Promise<{ matched: boolean; quarantined: boolean }>;
};

type GovernanceInternals3 = {
  executePurgeOneInTransaction: (
    t: unknown,
    sid: string,
    leaseToken: string,
    now: Date,
  ) => Promise<unknown>;
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
    for (const claim of claims)
      queryRaw.mockResolvedValueOnce(
        claim.map((row, index) => ({
          ...row,
          archiveId: `archive-${row.liveSessionId}`,
          purgeAttempts: index as unknown as bigint,
        })),
      );
    queryRaw.mockResolvedValue([]);
    // Every claim matches the archive lease assignment so rows are not skipped.
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      run: jest.fn((fn: (t: unknown) => unknown) =>
        fn({ $queryRaw: queryRaw, archivedResult: { updateMany } }),
      ),
      lockLiveSessionForUpdate: jest.fn(),
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
    const executePurgeOne = jest
      .spyOn(
        service as unknown as GovernanceInternals3,
        'executePurgeOneInTransaction',
      )
      .mockResolvedValue({ status: 'deleted' } as never);
    const now = new Date('2026-02-01T00:00:00.000Z');

    await expect(service.purgeDue(1000, now)).resolves.toEqual({
      selected: 2,
      deleted: 2,
      failed: 0,
    });
    expect(executePurgeOne.mock.calls.map((call) => call.slice(1))).toEqual([
      ['older', expect.any(String), now],
      ['newer', expect.any(String), now],
    ]);
  });

  it('continues after a failed item via a retry transition', async () => {
    const metrics = { recordJobItem: jest.fn(), recordJobRun: jest.fn() };
    const { service, queryRaw } = serviceWithClaims(
      [[{ liveSessionId: 'failed' }], [{ liveSessionId: 'continued' }]],
      metrics,
    );
    jest
      .spyOn(
        service as unknown as GovernanceInternals3,
        'executePurgeOneInTransaction',
      )
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
    // The failed row transitions to retry (lease matched) and is counted.
    expect(metrics.recordJobItem).toHaveBeenCalledWith(
      'retention_purge',
      'retried',
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

  it('replays an existing archive without rebuilding its payload', async () => {
    const sessionId = '018f1f1f-1111-7111-8111-111111111111';
    const payload = { schemaVersion: 1, questions: [] };
    const existing = {
      ...archive(sessionId, new Date('2026-04-01T00:00:00.000Z')),
      payload,
      status: 'active',
    };
    const session = {
      id: sessionId,
      status: 'closed',
      closedAt: new Date('2026-01-01T00:00:00.000Z'),
      course: {},
      questions: [],
      submissions: [],
    };
    const participantUpdate = jest.fn();
    const transaction = {
      liveSession: { findUnique: jest.fn().mockResolvedValue(session) },
      archivedResult: {
        findUnique: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
        update: jest.fn(),
      },
      participant: {
        findMany: jest.fn().mockResolvedValue([{ id: 'participant-1' }]),
        update: participantUpdate,
      },
    };
    const service = new GovernanceService(
      { prisma: {} } as never,
      {
        run: jest.fn((fn: (t: unknown) => unknown) => fn(transaction)),
        lockLiveSessionForUpdate: jest.fn(),
      } as never,
    );

    const result = await service.archiveSession(sessionId);

    expect(result).toMatchObject({ id: existing.id, liveSessionId: sessionId });
    expect(transaction.archivedResult.create).not.toHaveBeenCalled();
    expect(transaction.archivedResult.update).not.toHaveBeenCalled();
    expect(transaction.participant.update).toHaveBeenCalledWith({
      where: { id: 'participant-1' },
      data: expect.objectContaining({
        accountId: null,
        displayName: 'Anonymous',
        tokenHash: expect.any(String),
      }),
    });
    expect(existing.payload).toBe(payload);
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

  it('returns a write-free deletion plan for a due archive in dry-run', async () => {
    const count = jest.fn().mockResolvedValue(3);
    const deleteMany = jest.fn();
    const archivedResult = {
      updateMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({
        id: 'archive-1',
        liveSessionId: 'session-1',
      }),
      update: jest.fn(),
    };
    const transactionClient = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { liveSessionId: 'session-1', archiveId: 'archive-1' },
        ]),
      archivedResult,
      submission: { count, deleteMany },
      liveSessionEvent: { count, deleteMany },
      sessionQuestionOption: { count, deleteMany },
      sessionQuestion: { count, deleteMany },
      participant: { count, deleteMany },
      deletionEvent: { findFirst: jest.fn(), create: jest.fn() },
      deletionManifestOutbox: { create: jest.fn() },
    };
    const tx = {
      run: jest.fn((fn: (t: typeof transactionClient) => Promise<unknown>) =>
        fn(transactionClient),
      ),
    };
    const service = new GovernanceService({ prisma: {} } as never, tx as never);

    const result = await service.purgeDue(
      1,
      new Date('2026-02-01T00:00:00.000Z'),
      true,
    );

    expect(result.deleted).toBe(0);
    expect(result.planned).toHaveLength(1);
    expect(result.planned?.[0]).toMatchObject({
      archiveId: 'archive-1',
      liveSessionId: 'session-1',
      category: 'governed_deletion',
    });
    expect(deleteMany).not.toHaveBeenCalled();
    // Dry-run must never persist a lease (no archived_result.updateMany).
    expect(archivedResult.updateMany).not.toHaveBeenCalled();
  });

  it('claims due sessions under a durable lease and skips stolen rows', async () => {
    const $queryRaw = jest
      .fn()
      .mockResolvedValueOnce([
        {
          liveSessionId: 'older',
          archiveId: 'archive-older',
          purgeAttempts: 1n,
        },
        {
          liveSessionId: 'stolen',
          archiveId: 'archive-stolen',
          purgeAttempts: 2n,
        },
      ])
      .mockResolvedValue([]);
    const updateMany = jest
      .fn()
      // 'older' matches and is leased; 'stolen' is already reclaimed so matches 0.
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const transactionClient = {
      $queryRaw,
      archivedResult: { updateMany },
    } as never;
    const tx = {
      run: jest.fn((fn: (t: never) => unknown) => fn(transactionClient)),
      lockLiveSessionForUpdate: jest.fn(),
    };
    const service = new GovernanceService({ prisma: {} } as never, tx as never);

    const claimed = await (
      service as unknown as GovernanceInternals2
    ).claimDueInTransaction(transactionClient, new Date('2026-02-01'), 5);

    expect(claimed).toEqual([
      expect.objectContaining({
        liveSessionId: 'older',
        archiveId: 'archive-older',
        purgeAttempts: 2,
        leaseToken: expect.any(String),
      }),
    ]);
    // The stolen row's lease assignment matched 0 and is skipped.
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it('transitions a transient failure to retry with backoff, cased on the lease', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transactionClient = {
      archivedResult: { updateMany },
    } as never;
    const service = new GovernanceService({ prisma: {} } as never, {} as never);
    const now = new Date('2026-02-01T00:00:00.000Z');

    const decision = await (
      service as unknown as GovernanceInternals2
    ).transitionFailureInTransaction(
      transactionClient,
      'archive-1',
      'lease-token',
      'transient_db',
      1,
      now,
    );

    expect(decision).toEqual({ matched: true, quarantined: false });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'archive-1', purgeLeaseToken: 'lease-token' },
      data: {
        purgeState: 'retry',
        nextPurgeAttemptAt: new Date(now.getTime() + 250),
        lastPurgeFailureCode: 'transient_db',
        lastPurgeFailedAt: now,
        purgeLeaseToken: null,
        purgeLeaseExpiresAt: null,
      },
    });
  });

  it('quarantines a permanent failure and never alters purgeAt', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const transactionClient = {
      archivedResult: { updateMany },
    } as never;
    const service = new GovernanceService({ prisma: {} } as never, {} as never);
    const now = new Date('2026-02-01T00:00:00.000Z');

    const decision = await (
      service as unknown as GovernanceInternals2
    ).transitionFailureInTransaction(
      transactionClient,
      'archive-1',
      'lease-token',
      'fk_blocker',
      1,
      now,
    );

    expect(decision).toEqual({ matched: true, quarantined: true });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'archive-1', purgeLeaseToken: 'lease-token' },
      data: {
        purgeState: 'quarantined',
        quarantinedAt: now,
        lastPurgeFailureCode: 'fk_blocker',
        lastPurgeFailedAt: now,
        purgeLeaseToken: null,
        purgeLeaseExpiresAt: null,
      },
    });
  });
});
