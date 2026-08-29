import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { LiveGateway } from './live-gateway';
import { LiveSessionEventBus } from './live-session-event-bus';
import { LiveSessionPublisher } from './live-session-publisher';
import {
  RealtimeDeliveryState,
  RealtimeEvent,
  RealtimeSyncReason,
  RealtimeVisibility,
} from './live-session-realtime-contract';

const LIVE_SESSION_ID = '0190c6b8-0000-7000-8000-000000000001';
const EVENT_ID = '0190c6b8-0000-7000-8000-000000000002';
const QUESTION_ID = '0190c6b8-0000-7000-8000-000000000003';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type RawRow = {
  id: string;
  live_session_id: string;
  session_question_id: string | null;
  target_participant_id: string | null;
  event_name: string;
  schema_version: number;
  event_seq: bigint;
  aggregate_version: number;
  server_timestamp: Date;
  created_at: Date;
  visibility: string;
  projection_input: Prisma.JsonValue | null;
  delivery_state: string;
  attempt_count: number;
  next_attempt_at: Date;
  claimed_at: Date | null;
  claim_token: string | null;
  lease_expires_at: Date | null;
  last_failure_class: string | null;
  coalesced: boolean;
  delivered_at: Date | null;
  expires_at: Date | null;
};

type FakeDatabase = {
  $queryRaw: jest.Mock;
  $executeRaw: jest.Mock;
  $transaction: jest.Mock;
  liveSessionEvent: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
};

type Harness = {
  publisher: LiveSessionPublisher;
  database: FakeDatabase;
  transaction: { $queryRaw: jest.Mock };
  gateway: {
    isTransportReady: jest.Mock;
    dispatchDurableEvent: jest.Mock;
    notifySyncRequiredForSession: jest.Mock;
  };
};

function makeRow(overrides: Partial<RawRow> = {}): RawRow {
  const timestamp = new Date('2026-08-28T00:00:00.000Z');
  return {
    id: EVENT_ID,
    live_session_id: LIVE_SESSION_ID,
    session_question_id: QUESTION_ID,
    target_participant_id: null,
    event_name: RealtimeEvent.RESULT_UPDATED,
    schema_version: 1,
    event_seq: 7n,
    aggregate_version: 1,
    server_timestamp: timestamp,
    created_at: timestamp,
    visibility: RealtimeVisibility.TEACHER,
    projection_input: { sessionQuestionId: QUESTION_ID, aggregateVersion: 1 },
    delivery_state: RealtimeDeliveryState.PROCESSING,
    attempt_count: 1,
    next_attempt_at: timestamp,
    claimed_at: timestamp,
    claim_token: null,
    lease_expires_at: new Date(timestamp.getTime() + 10_000),
    last_failure_class: null,
    coalesced: false,
    delivered_at: null,
    expires_at: new Date(timestamp.getTime() + 86_400_000),
    ...overrides,
  };
}

function makeHarness(row = makeRow()): Harness {
  const transaction = { $queryRaw: jest.fn().mockResolvedValue([row]) };
  const database: FakeDatabase = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
    liveSessionEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  database.$transaction.mockImplementation(
    async (
      callback: (tx: typeof transaction) => Promise<RawRow[]>,
    ): Promise<RawRow[]> => callback(transaction),
  );
  const gateway = {
    isTransportReady: jest.fn().mockReturnValue(true),
    dispatchDurableEvent: jest.fn().mockResolvedValue(undefined),
    notifySyncRequiredForSession: jest.fn().mockResolvedValue(undefined),
  };
  const publisher = new LiveSessionPublisher(
    { prisma: database } as unknown as PrismaService,
    new LiveSessionEventBus(),
    gateway as unknown as LiveGateway,
  );
  return { publisher, database, transaction, gateway };
}

describe('LiveSessionPublisher', () => {
  it('does not claim rows before Socket.IO transport is ready', async () => {
    const harness = makeHarness();
    harness.gateway.isTransportReady.mockReturnValue(false);

    await expect(
      harness.publisher.processBatch(new Date('2026-08-28T00:00:00.000Z')),
    ).resolves.toBe(0);

    expect(harness.database.$transaction).not.toHaveBeenCalled();
    expect(harness.database.liveSessionEvent.findMany).not.toHaveBeenCalled();
  });

  it('retries transient delivery failures with bounded backoff', async () => {
    const now = new Date('2026-08-28T00:01:00.000Z');
    const harness = makeHarness(makeRow({ attempt_count: 1 }));
    harness.gateway.dispatchDurableEvent.mockRejectedValue(
      new Error('temporary socket failure'),
    );

    jest.useFakeTimers().setSystemTime(now);
    try {
      await expect(harness.publisher.processBatch(now)).resolves.toBe(1);

      expect(harness.database.liveSessionEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: EVENT_ID }),
          data: expect.objectContaining({
            deliveryState: RealtimeDeliveryState.RETRY,
            nextAttemptAt: new Date(now.getTime() + 250),
            lastFailureClass: 'transient',
          }),
        }),
      );
      expect(
        harness.gateway.notifySyncRequiredForSession,
      ).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['a permanent projection error', new TypeError('invalid projection'), 1],
    ['the maximum retry count', new Error('retry exhausted'), 5],
  ])(
    '%s becomes a dead letter and requests recovery',
    async (_label, error, attemptCount) => {
      const harness = makeHarness(makeRow({ attempt_count: attemptCount }));
      harness.gateway.dispatchDurableEvent.mockRejectedValue(error);

      await expect(
        harness.publisher.processBatch(new Date('2026-08-28T00:02:00.000Z')),
      ).resolves.toBe(1);

      expect(harness.database.liveSessionEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deliveryState: RealtimeDeliveryState.DEAD,
            lastFailureClass: attemptCount === 1 ? 'permanent' : 'transient',
          }),
        }),
      );
      expect(harness.gateway.notifySyncRequiredForSession).toHaveBeenCalledWith(
        LIVE_SESSION_ID,
        RealtimeSyncReason.DEAD,
      );
    },
  );

  it('marks a dead predecessor as recovery-notified before releasing its fence', async () => {
    const harness = makeHarness(makeRow({ attempt_count: 5 }));
    harness.gateway.notifySyncRequiredForSession.mockResolvedValue(true);
    harness.gateway.dispatchDurableEvent.mockRejectedValue(
      new Error('permanent delivery failure'),
    );

    await expect(
      harness.publisher.processBatch(new Date('2026-08-28T00:03:00.000Z')),
    ).resolves.toBe(1);

    expect(harness.database.liveSessionEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { lastFailureClass: 'recovery_notified' },
      }),
    );
  });

  it('claims in a transaction with lease and per-session ordering guards', async () => {
    const harness = makeHarness();

    await harness.publisher.processBatch(new Date('2026-08-28T00:03:00.000Z'));

    expect(harness.database.$transaction).toHaveBeenCalledTimes(1);
    const [queryFragments, ...parameters] = harness.transaction.$queryRaw.mock
      .calls[0] as [readonly string[], ...unknown[]];
    const query = queryFragments.join('');
    expect(query).toContain('SKIP LOCKED');
    expect(query).toContain('lease_expires_at');
    expect(query).toContain('previous.event_seq < event.event_seq');
    expect(query).toContain('previous.delivery_state = ');
    expect(parameters).toContain('recovery_notified');
  });

  it('bounds expiry, dead-letter recovery, and coalescing maintenance', async () => {
    const harness = makeHarness();

    await harness.publisher.processBatch(new Date('2026-08-28T00:04:00.000Z'));

    const maintenanceCalls =
      harness.database.liveSessionEvent.findMany.mock.calls.map(
        ([input]) => input as { take?: number },
      );
    expect(maintenanceCalls.filter((input) => input.take === 50)).toHaveLength(
      3,
    );
    const [queryFragments] = harness.database.$executeRaw.mock.calls[0] as [
      readonly string[],
      ...unknown[],
    ];
    expect(queryFragments.join('')).toContain('LIMIT');
  });

  it('waits for an in-flight drain before shutdown completes', async () => {
    jest.useFakeTimers();
    const harness = makeHarness();
    const batch = deferred<number>();
    jest
      .spyOn(harness.publisher, 'processBatch')
      .mockReturnValue(batch.promise);

    try {
      harness.publisher.onModuleInit();
      await flushPromises();
      expect(harness.publisher.processBatch).toHaveBeenCalledTimes(1);

      let shutdownCompleted = false;
      const shutdown = harness.publisher.onModuleDestroy().then(() => {
        shutdownCompleted = true;
      });
      await flushPromises();
      expect(shutdownCompleted).toBe(false);

      batch.resolve(0);
      await shutdown;
      expect(shutdownCompleted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('restarts with one startup scan after shutdown', async () => {
    jest.useFakeTimers();
    const harness = makeHarness();
    const processBatch = jest
      .spyOn(harness.publisher, 'processBatch')
      .mockResolvedValue(0);

    try {
      harness.publisher.onModuleInit();
      await flushPromises();
      await harness.publisher.onModuleDestroy();
      processBatch.mockClear();

      harness.publisher.onModuleInit();
      await flushPromises();

      expect(processBatch).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);
      await harness.publisher.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores duplicate init without duplicating subscriptions or timers', async () => {
    jest.useFakeTimers();
    const bus = new LiveSessionEventBus();
    const subscribe = jest.spyOn(bus, 'subscribe');
    const harness = makeHarness();
    const publisher = new LiveSessionPublisher(
      { prisma: harness.database } as unknown as PrismaService,
      bus,
      harness.gateway as unknown as LiveGateway,
    );
    const processBatch = jest
      .spyOn(publisher, 'processBatch')
      .mockResolvedValue(0);

    try {
      publisher.onModuleInit();
      publisher.onModuleInit();
      await flushPromises();

      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(processBatch).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);
      await publisher.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('repeated destroy releases outstanding leases only once', async () => {
    jest.useFakeTimers();
    const harness = makeHarness();
    const dispatch = deferred<void>();
    harness.gateway.dispatchDurableEvent.mockReturnValue(dispatch.promise);
    harness.database.liveSessionEvent.updateMany.mockResolvedValue({
      count: 0,
    });

    try {
      harness.publisher.onModuleInit();
      await flushPromises();
      const firstDestroy = harness.publisher.onModuleDestroy();
      const duplicateDestroy = harness.publisher.onModuleDestroy();
      dispatch.resolve(undefined);
      await Promise.all([firstDestroy, duplicateDestroy]);
      await harness.publisher.onModuleDestroy();

      const leaseCleanupCalls =
        harness.database.liveSessionEvent.updateMany.mock.calls.filter(
          ([input]) =>
            (input as { data?: { lastFailureClass?: string } }).data
              ?.lastFailureClass === 'lease_expired',
        );
      expect(leaseCleanupCalls).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
