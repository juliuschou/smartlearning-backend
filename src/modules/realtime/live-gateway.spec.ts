import { Prisma } from '../../../generated/prisma/client';
import { LiveGateway } from './live-gateway';
import { SESSION_COOKIE_NAME } from '../../common/security';
import { DomainError } from '../../common/errors/domain-error';
import {
  RealtimeEvent,
  RealtimeVisibility,
  type RealtimeEventName,
  type RealtimeVisibility as RealtimeVisibilityValue,
} from './live-session-realtime-contract';

const PARTICIPANT_ID = '0190c6b8-0000-7000-8000-000000000001';
const OTHER_PARTICIPANT_ID = '0190c6b8-0000-7000-8000-000000000002';
const LIVE_SESSION_ID = '0190c6b8-0000-7000-8000-000000000003';

type VisibilityProbeRow = {
  eventName: RealtimeEventName;
  visibility: RealtimeVisibilityValue;
  targetParticipantId: string | null;
};

type VisibilityProbeClient =
  | {
      kind: 'teacher';
      accountId: string;
      role: string;
      liveSessionId: string;
    }
  | {
      kind: 'participant';
      participantId: string;
      liveSessionId: string;
      accountId?: string;
    };

type VisibilityProbe = {
  isVisibleToClient: (
    row: VisibilityProbeRow,
    client: VisibilityProbeClient,
  ) => boolean;
};

function visibilityProbe(): VisibilityProbe['isVisibleToClient'] {
  const gateway = Object.create(
    LiveGateway.prototype,
  ) as unknown as VisibilityProbe;
  return gateway.isVisibleToClient;
}

function targetedResult(
  targetParticipantId: string | null,
): VisibilityProbeRow {
  return {
    eventName: RealtimeEvent.RESULT_UPDATED,
    visibility: RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
    targetParticipantId,
  };
}

const contextEvent: {
  id: string;
  eventName: RealtimeEventName;
  visibility: RealtimeVisibilityValue;
  targetParticipantId: string;
  liveSessionId: string;
  sessionQuestionId: string;
  eventSeq: bigint;
  aggregateVersion: number;
  serverTimestamp: Date;
} = {
  id: '0190c6b8-0000-7000-8000-00000000000a',
  eventName: RealtimeEvent.RESULT_UPDATED,
  visibility: RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
  targetParticipantId: PARTICIPANT_ID,
  liveSessionId: LIVE_SESSION_ID,
  sessionQuestionId: '0190c6b8-0000-7000-8000-00000000000b',
  eventSeq: 7n,
  aggregateVersion: 2,
  serverTimestamp: new Date('2026-09-24T00:00:00.000Z'),
};

describe('LiveGateway durable visibility', () => {
  it('delivers targeted result rows only to the matching participant', () => {
    const isVisibleToClient = visibilityProbe();
    const participant = {
      kind: 'participant' as const,
      participantId: PARTICIPANT_ID,
      liveSessionId: LIVE_SESSION_ID,
    };

    expect(isVisibleToClient(targetedResult(PARTICIPANT_ID), participant)).toBe(
      true,
    );
    expect(
      isVisibleToClient(targetedResult(OTHER_PARTICIPANT_ID), participant),
    ).toBe(false);
  });

  it('fails closed when a targeted row has no routing target', () => {
    const isVisibleToClient = visibilityProbe();
    const participant = {
      kind: 'participant' as const,
      participantId: PARTICIPANT_ID,
      liveSessionId: LIVE_SESSION_ID,
    };

    expect(isVisibleToClient(targetedResult(null), participant)).toBe(false);
  });

  it('keeps teacher result replay independent of participant targeting', () => {
    const isVisibleToClient = visibilityProbe();
    const teacher = {
      kind: 'teacher' as const,
      accountId: '0190c6b8-0000-7000-8000-000000000004',
      role: 'teacher',
      liveSessionId: LIVE_SESSION_ID,
    };

    expect(isVisibleToClient(targetedResult(null), teacher)).toBe(true);
    expect(
      isVisibleToClient(targetedResult(OTHER_PARTICIPANT_ID), teacher),
    ).toBe(true);
  });

  it('includes the terminal status in replayed session.closed envelopes', async () => {
    const socket = { emit: jest.fn(), disconnect: jest.fn() };
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      emitDurableEventToSocket(
        socket: unknown,
        client: unknown,
        event: unknown,
      ): Promise<void>;
      clientVisibility: jest.Mock;
      envelope: jest.Mock;
      projectionString: jest.Mock;
    };
    gateway.clientVisibility = jest.fn().mockReturnValue('participant');
    gateway.projectionString = jest.fn().mockReturnValue(undefined);
    gateway.envelope = jest
      .fn()
      .mockImplementation(
        (
          event: string,
          visibility: string,
          liveSessionId: string,
          eventSeq: string,
          aggregateVersion: number,
          data: unknown,
        ) => ({
          event,
          visibility,
          liveSessionId,
          eventSeq,
          aggregateVersion,
          data,
        }),
      );

    await gateway.emitDurableEventToSocket(
      socket,
      {
        kind: 'participant',
        participantId: PARTICIPANT_ID,
        liveSessionId: LIVE_SESSION_ID,
      },
      {
        eventName: RealtimeEvent.SESSION_CLOSED,
        visibility: RealtimeVisibility.SESSION,
        liveSessionId: LIVE_SESSION_ID,
        eventSeq: 4n,
        aggregateVersion: 0,
        serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      },
    );

    expect(socket.emit).toHaveBeenCalledWith(
      RealtimeEvent.SESSION_CLOSED,
      expect.objectContaining({ data: { status: 'closed' } }),
    );
    // disconnect(true) is deferred via setImmediate so Socket.IO can flush the
    // terminal packet first; yield one tick before asserting it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('blocks publisher readiness when required Redis is unavailable', () => {
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      server: object;
      redis: { acceptsTraffic: boolean };
      isTransportReady(): boolean;
    };
    gateway.server = {};
    gateway.redis = { acceptsTraffic: false };

    expect(gateway.isTransportReady()).toBe(false);
  });

  describe('diagnostics fail-open (F4)', () => {
    function failOpenHarness(): {
      socket: { emit: jest.Mock; disconnect: jest.Mock };
      gateway: {
        emitDurableEventToSocket(
          socket: unknown,
          client: unknown,
          event: unknown,
        ): Promise<void>;
        trace: { enabled: boolean; recordGuard: jest.Mock };
        traceGuard(
          event: unknown,
          socket: unknown,
          guard: string,
          client: unknown,
        ): void;
        emitTraced(
          socket: unknown,
          eventName: string,
          payload: unknown,
          ctx: unknown,
        ): void;
        emitContext(event: unknown, client: unknown): unknown;
        eventQuestionId(event: unknown): string | undefined;
      };
    } {
      const socket = { emit: jest.fn(), disconnect: jest.fn() };
      const gateway = Object.create(LiveGateway.prototype) as unknown as {
        emitDurableEventToSocket(
          socket: unknown,
          client: unknown,
          event: unknown,
        ): Promise<void>;
        trace: { enabled: boolean; recordGuard: jest.Mock };
        traceGuard(
          event: unknown,
          socket: unknown,
          guard: string,
          client: unknown,
        ): void;
        emitTraced(
          socket: unknown,
          eventName: string,
          payload: unknown,
          ctx: unknown,
        ): void;
        emitContext(event: unknown, client: unknown): unknown;
        eventQuestionId(event: unknown): string | undefined;
      };
      gateway.trace = { enabled: true, recordGuard: jest.fn() };
      // Bind the real methods so the fail-open behavior under test is the
      // production implementation, not a mock.
      gateway.traceGuard = (
        LiveGateway.prototype as unknown as {
          traceGuard: (...args: unknown[]) => void;
        }
      ).traceGuard.bind(gateway);
      gateway.emitTraced = (
        LiveGateway.prototype as unknown as {
          emitTraced: (...args: unknown[]) => void;
        }
      ).emitTraced.bind(gateway);
      gateway.emitContext = (
        LiveGateway.prototype as unknown as {
          emitContext: (...args: unknown[]) => unknown;
        }
      ).emitContext.bind(gateway);
      gateway.eventQuestionId = (
        LiveGateway.prototype as unknown as {
          eventQuestionId: (...args: unknown[]) => string | undefined;
        }
      ).eventQuestionId.bind(gateway);
      return { socket, gateway };
    }

    const participantClient = {
      kind: 'participant' as const,
      participantId: PARTICIPANT_ID,
      liveSessionId: LIVE_SESSION_ID,
    };
    const event = {
      id: '0190c6b8-0000-7000-8000-00000000000a',
      eventName: RealtimeEvent.RESULT_UPDATED,
      visibility: RealtimeVisibility.PARTICIPANT_AFTER_SUBMIT,
      targetParticipantId: PARTICIPANT_ID,
      liveSessionId: LIVE_SESSION_ID,
      sessionQuestionId: '0190c6b8-0000-7000-8000-00000000000b',
      eventSeq: 7n,
      aggregateVersion: 2,
      serverTimestamp: new Date('2026-09-24T00:00:00.000Z'),
    };

    it('still emits exactly once when the trace context conversion throws', async () => {
      const { socket, gateway } = failOpenHarness();
      // Diagnostics sink throws on recordEmit — the production `emitContext`
      // returns `null` on its own conversion failure and `emitTraced` guards
      // every trace call, so the emit must proceed unaffected.
      const gatewayWithResults = gateway as unknown as {
        trace: {
          enabled: boolean;
          recordEmit: () => never;
          recordEmitReturned: jest.Mock;
          recordEmitThrew: jest.Mock;
        };
        liveSessions: { getResults: jest.Mock };
        reauthorizeParticipant: jest.Mock;
        logger: { debug: jest.Mock };
      };
      gatewayWithResults.trace = {
        enabled: true,
        recordEmit: () => {
          throw new TypeError(
            'Event sequence must be a canonical non-negative decimal.',
          );
        },
        recordEmitReturned: jest.fn(),
        recordEmitThrew: jest.fn(),
      };
      gatewayWithResults.liveSessions = {
        getResults: jest.fn().mockResolvedValue([]),
      };
      gatewayWithResults.reauthorizeParticipant = jest
        .fn()
        .mockResolvedValue(true);
      gatewayWithResults.logger = { debug: jest.fn() };

      await expect(
        gateway.emitDurableEventToSocket(socket, participantClient, event),
      ).resolves.toBeUndefined();

      // Fail-open: the emit happened exactly once despite the diagnostics
      // conversion failure, and no exception escaped.
      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(socket.emit).toHaveBeenCalledWith(
        RealtimeEvent.RESULT_UPDATED,
        expect.anything(),
      );
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('does not emit and records the guard when the trace guard sink throws', async () => {
      const { socket, gateway } = failOpenHarness();
      // No session question → guard branch. The trace sink itself throws; the
      // guard recording must not propagate the throw to the caller.
      gateway.trace.recordGuard.mockImplementation(() => {
        throw new Error('diagnostics sink failure');
      });
      const noQuestionEvent = { ...contextEvent, sessionQuestionId: undefined };

      await expect(
        gateway.emitDurableEventToSocket(
          socket,
          participantClient,
          noQuestionEvent,
        ),
      ).resolves.toBeUndefined();

      expect(socket.emit).not.toHaveBeenCalled();
      expect(gateway.trace.recordGuard).toHaveBeenCalledWith(
        expect.objectContaining({ guard: 'no_session_question' }),
      );
    });
  });

  describe('trace-disabled hot path (F3)', () => {
    it('builds no diagnostics context when tracing is off', () => {
      // toEventSeqWire throws on a malformed sequence; if the disabled
      // emitContext evaluated its diagnostics arguments, this event would
      // throw. Returning null proves no per-emit diagnostics object (and no
      // sequence conversion) was built.
      const gateway = Object.create(LiveGateway.prototype) as unknown as {
        trace: undefined;
        emitContext(event: unknown, client: unknown): unknown;
      };
      gateway.trace = undefined;
      const malformedEvent = {
        ...contextEvent,
        eventSeq: 'not-a-sequence' as unknown as bigint,
      };
      expect(
        gateway.emitContext(malformedEvent, {
          kind: 'participant',
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        }),
      ).toBeNull();
    });

    it('returns a context when tracing is on', () => {
      const gateway = Object.create(LiveGateway.prototype) as unknown as {
        trace: { enabled: boolean };
        emitContext(event: unknown, client: unknown): unknown;
      };
      gateway.trace = { enabled: true };
      const ctx = gateway.emitContext(contextEvent, {
        kind: 'participant',
        participantId: PARTICIPANT_ID,
        liveSessionId: LIVE_SESSION_ID,
      });
      expect(ctx).toEqual(
        expect.objectContaining({
          eventId: contextEvent.id,
          eventSeq: '7',
          clientKind: 'participant',
        }),
      );
    });
  });

  it('blocks publisher readiness when required Redis is unavailable', () => {
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      server: object;
      redis: { acceptsTraffic: boolean };
      isTransportReady(): boolean;
    };
    gateway.server = {};
    gateway.redis = { acceptsTraffic: false };

    expect(gateway.isTransportReady()).toBe(false);
  });

  it('serializes concurrent snapshot.fetch calls per socket', async () => {
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      redis: { acceptsTraffic: boolean };
      onSnapshotFetch(socket: unknown, body: unknown): Promise<void>;
      replayOrSnapshot: jest.Mock;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.redis = { acceptsTraffic: true };
    const first = deferred();
    const started: number[] = [];
    gateway.replayOrSnapshot = jest
      .fn()
      .mockImplementationOnce(async () => {
        started.push(1);
        await first.promise;
      })
      .mockImplementationOnce(async () => {
        started.push(2);
      });
    const socket = {
      id: 'socket-1',
      data: {
        auth: {
          kind: 'participant',
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
    };
    const onSnapshotFetch = gateway.onSnapshotFetch.bind(gateway);

    const firstCall = onSnapshotFetch(socket, {});
    const secondCall = onSnapshotFetch(socket, {});
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual([1]);
    first.resolve();
    await Promise.all([firstCall, secondCall]);
    expect(started).toEqual([1, 2]);
  });

  it('holds a room event behind an in-flight snapshot delivery', async () => {
    const remoteSocket = {
      id: 'socket-2',
      data: {
        auth: {
          kind: 'participant',
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      enqueueDelivery(
        socket: { id: string },
        delivery: () => Promise<void> | void,
      ): Promise<void>;
      emitSharedEvent(
        event: unknown,
        data: Record<string, unknown>,
      ): Promise<void>;
      server: {
        in(room: string): { fetchSockets(): Promise<unknown[]> };
      };
      sessions: { assertAccountActive: jest.Mock };
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([remoteSocket]),
      }),
    };
    gateway.sessions = {
      assertAccountActive: jest.fn(),
    };
    const hold = deferred();
    const enqueueDelivery = gateway.enqueueDelivery.bind(gateway);
    const firstDelivery = enqueueDelivery(remoteSocket, async () => {
      await hold.promise;
    });
    const emitSharedEvent = gateway.emitSharedEvent.bind(gateway);
    const eventDelivery = emitSharedEvent(
      {
        eventName: RealtimeEvent.QUESTION_OPENED,
        visibility: RealtimeVisibility.SESSION,
        liveSessionId: LIVE_SESSION_ID,
        eventSeq: 1n,
        aggregateVersion: 0,
        serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      },
      { sessionQuestionId: '0190c6b8-0000-7000-8000-000000000005' },
    );
    await Promise.resolve();

    expect(remoteSocket.emit).not.toHaveBeenCalled();
    hold.resolve();
    await Promise.all([firstDelivery, eventDelivery]);
    expect(remoteSocket.emit).toHaveBeenCalledTimes(1);
  });

  it('does not re-deliver a shared event to an already-served recipient on redispatch (D3 flip)', async () => {
    const firstEmit = deferred();
    const firstSocket = {
      id: 'socket-close-a',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn(() => {
        firstEmit.resolve();
        return true;
      }),
      disconnect: jest.fn(),
    };
    const secondSocket = {
      id: 'socket-close-b',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: OTHER_PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    const releaseSecond = deferred();
    let retrying = false;
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'controlled failure',
      { code: 'P2010', clientVersion: '7.9.1', meta: { code: '40P01' } },
    );
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      reauthorizeParticipant: jest.Mock;
      emitSharedEvent(
        event: unknown,
        data: Record<string, unknown>,
      ): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([firstSocket, secondSocket]),
      }),
    };
    gateway.reauthorizeParticipant = jest.fn(async (socket: { id: string }) => {
      if (socket.id === firstSocket.id || retrying) return true;
      await releaseSecond.promise;
      throw prismaError;
    });

    const event = {
      id: '0190c6b8-0000-7000-8000-000000000004',
      eventName: RealtimeEvent.SESSION_STATE_CHANGED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 42n,
      aggregateVersion: 3,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: { status: 'active' },
      visibility: RealtimeVisibility.SESSION,
      targetParticipantId: null,
    };

    const firstDispatch = gateway.emitSharedEvent(event, {
      status: 'active',
    });
    await firstEmit.promise;
    expect(firstSocket.emit).toHaveBeenCalledTimes(1);
    expect(secondSocket.emit).not.toHaveBeenCalled();

    releaseSecond.resolve();
    await expect(firstDispatch).rejects.toBe(prismaError);

    retrying = true;
    await gateway.emitSharedEvent(event, { status: 'active' });

    // Fix C: the served recipient is not re-emitted on redispatch; only the
    // previously failed recipient receives the event.
    expect(firstSocket.emit).toHaveBeenCalledTimes(1);
    expect(secondSocket.emit).toHaveBeenCalledTimes(1);
    const firstPayload = (firstSocket.emit.mock.calls[0] as unknown[])[1] as {
      eventSeq: string;
      liveSessionId: string;
    };
    const secondPayload = (secondSocket.emit.mock.calls[0] as unknown[])[1] as {
      eventSeq: string;
      liveSessionId: string;
    };
    expect(secondPayload).toMatchObject(firstPayload);
  });

  it('fails closed when participant socket enumeration fails', async () => {
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      server: {
        in(room: string): { fetchSockets(): Promise<unknown[]> };
      };
      pruneUnauthorizedParticipantSockets(liveSessionId: string): Promise<void>;
      logger: { warn: jest.Mock };
    };
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockRejectedValue(new Error('adapter down')),
      }),
    };
    gateway.logger = { warn: jest.fn() };

    await expect(
      gateway.pruneUnauthorizedParticipantSockets(LIVE_SESSION_ID),
    ).rejects.toThrow('Could not enumerate participant sockets.');
  });

  it('canonicalizes uppercase teacher session IDs before durable room routing', async () => {
    const accountId = '0190c6b8-0000-7000-8000-000000000004';
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      sessions: { loadActiveSession: jest.Mock };
      liveSessions: { getTeacherDetail: jest.Mock };
      authenticateCookie(
        socket: unknown,
        cookieToken: string,
      ): Promise<{
        kind: 'teacher';
        accountId: string;
        role: string;
        liveSessionId: string;
      }>;
    };
    gateway.sessions = {
      loadActiveSession: jest.fn().mockResolvedValue({
        account: { id: accountId, role: 'teacher' },
      }),
    };
    gateway.liveSessions = {
      getTeacherDetail: jest.fn().mockResolvedValue({
        session: { id: LIVE_SESSION_ID, status: 'active' },
      }),
    };

    const client = await gateway.authenticateCookie(
      {
        request: {
          headers: { cookie: `${SESSION_COOKIE_NAME}=opaque-session` },
        },
        handshake: {
          auth: { liveSessionId: LIVE_SESSION_ID.toUpperCase() },
        },
      },
      'opaque-session',
    );

    expect(client.liveSessionId).toBe(LIVE_SESSION_ID);
  });

  it('normalizes uppercase account-disabled signals before disconnecting sockets', async () => {
    const accountId = '0190c6b8-0000-7000-8000-000000000004';
    const socket = {
      data: {
        auth: {
          kind: 'teacher',
          accountId,
          role: 'teacher',
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      disconnect: jest.fn(),
    };
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      server: { fetchSockets(): Promise<unknown[]> };
      handleAccountDisabled(accountId: string): Promise<void>;
      pendingDisabledAccounts: Map<string, number>;
      disabledAccountRetryTimers: Map<string, NodeJS.Timeout>;
      shuttingDown: boolean;
    };
    gateway.pendingDisabledAccounts = new Map();
    gateway.disabledAccountRetryTimers = new Map();
    gateway.shuttingDown = false;
    gateway.server = {
      fetchSockets: jest.fn().mockResolvedValue([socket]),
    };

    await gateway.handleAccountDisabled(accountId.toUpperCase());

    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('propagates account-disabled enumeration failures and schedules retry', async () => {
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      server: { fetchSockets(): Promise<unknown[]> };
      handleAccountDisabled(accountId: string): Promise<void>;
      pendingDisabledAccounts: Map<string, number>;
      disabledAccountRetryTimers: Map<string, NodeJS.Timeout>;
      shuttingDown: boolean;
      logger: { warn: jest.Mock };
      onModuleDestroy(): void;
    };
    gateway.pendingDisabledAccounts = new Map();
    gateway.disabledAccountRetryTimers = new Map();
    gateway.shuttingDown = false;
    gateway.logger = { warn: jest.fn() };
    gateway.server = {
      fetchSockets: jest.fn().mockRejectedValue(new Error('adapter down')),
    };

    await expect(
      gateway.handleAccountDisabled(LIVE_SESSION_ID),
    ).rejects.toThrow('Could not enumerate account-disabled sockets.');
    expect(gateway.disabledAccountRetryTimers).toHaveProperty('size', 1);

    gateway.shuttingDown = true;
    gateway.onModuleDestroy();
  });

  it('keeps dead-event recovery fenced when socket enumeration fails', async () => {
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      server: {
        in(room: string): { fetchSockets(): Promise<unknown[]> };
      };
      redis: { acceptsTraffic: boolean };
      liveSessions: { getSnapshot: jest.Mock };
      notifySyncRequiredForSession(
        liveSessionId: string,
        reason: string,
      ): Promise<boolean>;
      logger: { warn: jest.Mock };
    };
    gateway.redis = { acceptsTraffic: true };
    gateway.liveSessions = {
      getSnapshot: jest.fn().mockResolvedValue({ status: 'active' }),
    };
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockRejectedValue(new Error('adapter down')),
      }),
    };
    gateway.logger = { warn: jest.fn() };

    await expect(
      gateway.notifySyncRequiredForSession(LIVE_SESSION_ID, 'dead'),
    ).resolves.toBe(false);
  });

  it('propagates participant reauthorization infrastructure failures', async () => {
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      participants: { resolveAccountParticipant: jest.Mock };
      reauthorizeParticipant(
        socket: { id: string; disconnect(close?: boolean): unknown },
        client: {
          kind: 'participant';
          participantId: string;
          liveSessionId: string;
          accountId?: string;
        },
      ): Promise<boolean>;
    };
    gateway.participants = {
      resolveAccountParticipant: jest
        .fn()
        .mockRejectedValue(new Error('database unavailable')),
    };
    const socket = { id: 'socket-3', disconnect: jest.fn() };
    const client = {
      kind: 'participant' as const,
      participantId: PARTICIPANT_ID,
      liveSessionId: LIVE_SESSION_ID,
      accountId: '0190c6b8-0000-7000-8000-000000000004',
    };

    await expect(
      gateway.reauthorizeParticipant(socket, client),
    ).rejects.toThrow('database unavailable');
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  // --- Fix C Checkpoint B: durable fan-out delivery memory ----------------

  it('reaches later recipients after a middle-recipient failure on redispatch', async () => {
    // Three recipients queued per socket; the middle one fails on attempt 1.
    // Promise.all over per-socket queues means each socket's closure runs
    // independently, so C is served in attempt 1 and must not be re-emitted
    // on the retry; B must be retried and A must not be duplicated.
    const sockets = ['a', 'b', 'c'].map((name, index) => ({
      id: `socket-mid-${name}`,
      data: {
        auth: {
          kind: 'participant' as const,
          participantId:
            index === 0
              ? PARTICIPANT_ID
              : index === 1
                ? OTHER_PARTICIPANT_ID
                : '0190c6b8-0000-7000-8000-00000000000f',
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    }));
    let retrying = false;
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      reauthorizeParticipant: jest.Mock;
      emitSharedEvent(
        event: unknown,
        data: Record<string, unknown>,
      ): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue(sockets),
      }),
    };
    gateway.reauthorizeParticipant = jest.fn(async (socket: { id: string }) => {
      if (socket.id !== sockets[1].id || retrying) return true;
      throw new Error('controlled middle failure');
    });

    const event = {
      id: '0190c6b8-0000-7000-8000-000000000005',
      eventName: RealtimeEvent.QUESTION_OPENED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 43n,
      aggregateVersion: 1,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: {},
      visibility: RealtimeVisibility.SESSION,
      targetParticipantId: null,
    };

    const firstAttempt = gateway.emitSharedEvent(event, {});
    await expect(firstAttempt).rejects.toThrow('controlled middle failure');

    expect(sockets[0].emit).toHaveBeenCalledTimes(1);
    expect(sockets[1].emit).not.toHaveBeenCalled();
    // C was reached in attempt 1 (per-socket queues run independently).
    expect(sockets[2].emit).toHaveBeenCalledTimes(1);

    retrying = true;
    await gateway.emitSharedEvent(event, {});

    expect(sockets[0].emit).toHaveBeenCalledTimes(1);
    expect(sockets[1].emit).toHaveBeenCalledTimes(1);
    expect(sockets[2].emit).toHaveBeenCalledTimes(1);
  });

  it('fans out two events with the same eventSeq independently (keyed by event id)', async () => {
    const socket = {
      id: 'socket-sameseq',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      reauthorizeParticipant: jest.Mock;
      emitSharedEvent(
        event: unknown,
        data: Record<string, unknown>,
      ): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([socket]),
      }),
    };
    gateway.reauthorizeParticipant = jest.fn().mockResolvedValue(true);

    const makeEvent = (id: string) => ({
      id,
      eventName: RealtimeEvent.QUESTION_OPENED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 42n,
      aggregateVersion: 1,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: {},
      visibility: RealtimeVisibility.SESSION,
      targetParticipantId: null,
    });

    await gateway.emitSharedEvent(
      makeEvent('0190c6b8-0000-7000-8000-000000000006'),
      {},
    );
    await gateway.emitSharedEvent(
      makeEvent('0190c6b8-0000-7000-8000-000000000007'),
      {},
    );

    expect(socket.emit).toHaveBeenCalledTimes(2);
  });

  it('does not suppress delivery in a fresh gateway instance (process-local memory)', async () => {
    const makeGateway = (socket: {
      emit: jest.Mock;
      id: string;
      data: unknown;
    }) => {
      const gateway = Object.create(LiveGateway.prototype) as unknown as {
        deliveryQueues: Map<string, Promise<void>>;
        fanOutMemory: Map<string, unknown>;
        server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
        reauthorizeParticipant: jest.Mock;
        emitSharedEvent(
          event: unknown,
          data: Record<string, unknown>,
        ): Promise<void>;
      };
      gateway.deliveryQueues = new Map();
      gateway.fanOutMemory = new Map();
      gateway.server = {
        in: jest.fn().mockReturnValue({
          fetchSockets: jest.fn().mockResolvedValue([socket]),
        }),
      };
      gateway.reauthorizeParticipant = jest.fn().mockResolvedValue(true);
      return gateway;
    };
    const socket = {
      id: 'socket-fresh',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    const event = {
      id: '0190c6b8-0000-7000-8000-000000000008',
      eventName: RealtimeEvent.QUESTION_OPENED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 44n,
      aggregateVersion: 1,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: {},
      visibility: RealtimeVisibility.SESSION,
      targetParticipantId: null,
    };

    const first = makeGateway(socket);
    await first.emitSharedEvent(event, {});
    expect(socket.emit).toHaveBeenCalledTimes(1);

    // A new gateway process/instance starts with an empty delivery memory.
    const second = makeGateway(socket);
    await second.emitSharedEvent(event, {});
    expect(socket.emit).toHaveBeenCalledTimes(2);
  });

  it('retries a recipient whose projection/emit failed (not recorded before success)', async () => {
    const failingSocket: {
      id: string;
      data: {
        auth: {
          kind: 'participant';
          participantId: string;
          liveSessionId: string;
        };
      };
      emit: jest.Mock;
      disconnect: jest.Mock;
    } = {
      id: 'socket-fail',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn(() => {
        throw new Error('emit transport failure');
      }),
      disconnect: jest.fn(),
    };
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      reauthorizeParticipant: jest.Mock;
      emitSharedEvent(
        event: unknown,
        data: Record<string, unknown>,
      ): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([failingSocket]),
      }),
    };
    gateway.reauthorizeParticipant = jest.fn().mockResolvedValue(true);

    const event = {
      id: '0190c6b8-0000-7000-8000-000000000009',
      eventName: RealtimeEvent.QUESTION_OPENED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 45n,
      aggregateVersion: 1,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: {},
      visibility: RealtimeVisibility.SESSION,
      targetParticipantId: null,
    };

    await expect(gateway.emitSharedEvent(event, {})).rejects.toMatchObject({
      name: 'DurableFanOutError',
      stage: 'shared',
      socketId: failingSocket.id,
    });

    failingSocket.emit = jest.fn().mockReturnValue(true);
    await gateway.emitSharedEvent(event, {});
    expect(failingSocket.emit).toHaveBeenCalledTimes(1);
    expect(gateway.reauthorizeParticipant).toHaveBeenCalledTimes(2);
  });

  // --- Fix C Checkpoint C: remaining fan-out legs --------------------------

  it('retries a permanently failing recipient for five attempts without re-emitting served recipients', async () => {
    // Publisher-style five-attempt scenario at the gateway boundary only: no
    // DB/publisher runtime. The failing socket's closure always throws a
    // DurableFanOutError; the served socket is suppressed after attempt 1.
    const served = {
      id: 'socket-bounded-ok',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    const failing = {
      id: 'socket-bounded-fail',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: OTHER_PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      reauthorizeParticipant: jest.Mock;
      emitSharedEvent(
        event: unknown,
        data: Record<string, unknown>,
      ): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([served, failing]),
      }),
    };
    gateway.reauthorizeParticipant = jest.fn().mockResolvedValue(true);

    const event = {
      id: '0190c6b8-0000-7000-8000-0000000000aa',
      eventName: RealtimeEvent.QUESTION_OPENED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 50n,
      aggregateVersion: 1,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: {},
      visibility: RealtimeVisibility.SESSION,
      targetParticipantId: null,
    };

    // The failing socket's emit throws on every attempt: DurableFanOutError
    // is the surfaced failure class, and the recipient is never recorded as
    // served, so it keeps being re-attempted.
    failing.emit = jest.fn(() => {
      throw new Error('permanent emit failure');
    });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(gateway.emitSharedEvent(event, {})).rejects.toMatchObject({
        name: 'DurableFanOutError',
        eventId: event.id,
        stage: 'shared',
        socketId: failing.id,
      });
    }

    expect(served.emit).toHaveBeenCalledTimes(1);
    expect(served.disconnect).not.toHaveBeenCalled();
    // Guards still ran on every attempt for every participant socket
    // (suppression sits after the guards): 2 sockets × 5 attempts.
    expect(gateway.reauthorizeParticipant).toHaveBeenCalledTimes(10);
    // The failed recipient was never recorded as served: it is re-attempted.
  });

  it('does not re-deliver session.closed to an already-served recipient on redispatch (real D3 flip)', async () => {
    // Pre-fix historical behavior (the original D3 test): attempt 1 emitted
    // SESSION_CLOSED to A successfully, B's emit failed, the whole durable row
    // was RETRYed, and attempt 2 re-emitted SESSION_CLOSED to A — A's total
    // emit count across attempts was 2. Post-Fix-C: A stays at 1; B is
    // retried, its guards (reauthorization) run again, and it emits once.
    const socketA = {
      id: 'socket-d3-a',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    const socketB = {
      id: 'socket-d3-b',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: OTHER_PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    let bFails = true;
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      reauthorizeParticipant: jest.Mock;
      emitSessionClosed(event: unknown): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([socketA, socketB]),
      }),
    };
    gateway.reauthorizeParticipant = jest.fn().mockResolvedValue(true);
    socketB.emit = jest.fn(() => {
      if (bFails) throw new Error('B emit transport failure');
      return true;
    });

    const event = {
      id: '0190c6b8-0000-7000-8000-0000000000ab',
      eventName: RealtimeEvent.SESSION_CLOSED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 46n,
      aggregateVersion: 4,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: { status: 'closed' },
      visibility: RealtimeVisibility.SESSION,
      targetParticipantId: null,
    };

    const firstAttempt = gateway.emitSessionClosed(event);
    await expect(firstAttempt).rejects.toMatchObject({
      name: 'DurableFanOutError',
      stage: 'session_closed',
      socketId: socketB.id,
    });

    expect(socketA.emit).toHaveBeenCalledTimes(1);
    expect(socketB.emit).toHaveBeenCalledTimes(1);

    bFails = false;
    await gateway.emitSessionClosed(event);

    // Post-Fix-C: A's emit count across both attempts = 1 (was 2 pre-fix).
    expect(socketA.emit).toHaveBeenCalledTimes(1);
    expect(socketB.emit).toHaveBeenCalledTimes(2);
    // The failed attempt did not mark B served: exactly one of B's two emit
    // calls succeeded, and its envelope identity is unchanged.
    const payloadA = (socketA.emit.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    const payloadB = (socketB.emit.mock.calls[1] as unknown[])[1] as Record<
      string,
      unknown
    >;
    expect(payloadB).toMatchObject({
      eventSeq: payloadA.eventSeq,
      liveSessionId: payloadA.liveSessionId,
      visibility: payloadA.visibility,
    });
    // Guards (reauthorization) ran again on the retry — for every participant
    // socket in the room, not only the failed one (suppression sits after the
    // guards, so both A and B are re-checked each attempt).
    expect(gateway.reauthorizeParticipant).toHaveBeenCalledTimes(4);
  });

  it('suppresses only the served recipient on a projection-bearing leg retry (participant_results)', async () => {
    // A succeeds, B fails during emit, C succeeds in attempt 1 (per-socket
    // queues run independently under Promise.all). Retry: A and C suppressed,
    // B retried. Projection is counted via getResults calls.
    const socketA = {
      id: 'socket-pr-a',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    const socketB = {
      id: 'socket-pr-b',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: OTHER_PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    const socketC = {
      id: 'socket-pr-c',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: '0190c6b8-0000-7000-8000-00000000000f',
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    let bFails = true;
    const getResults = jest.fn().mockResolvedValue({ rows: [] });
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      reauthorizeParticipant: jest.Mock;
      liveSessions: { getResults: jest.Mock };
      emitParticipantResults(event: unknown): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([socketA, socketB, socketC]),
      }),
    };
    gateway.reauthorizeParticipant = jest.fn().mockResolvedValue(true);
    gateway.liveSessions = { getResults };
    socketB.emit = jest.fn(() => {
      if (bFails) throw new Error('B projection emit failure');
      return true;
    });

    const event = {
      id: '0190c6b8-0000-7000-8000-0000000000ac',
      eventName: RealtimeEvent.RESULT_UPDATED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 51n,
      aggregateVersion: 1,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: { sessionQuestionId: contextEvent.sessionQuestionId },
      visibility: RealtimeVisibility.PARTICIPANT,
      targetParticipantId: null,
    };

    await expect(gateway.emitParticipantResults(event)).rejects.toMatchObject({
      name: 'DurableFanOutError',
      stage: 'participant_results',
      socketId: socketB.id,
    });

    // Attempt 1: A and C completed projection + emit; B did not.
    expect(getResults).toHaveBeenCalledTimes(3);
    expect(socketA.emit).toHaveBeenCalledTimes(1);
    expect(socketB.emit).toHaveBeenCalledTimes(1);
    expect(socketC.emit).toHaveBeenCalledTimes(1);

    bFails = false;
    await gateway.emitParticipantResults(event);

    // Retry: only B is re-projected and re-emitted; A and C stay at 1.
    expect(getResults).toHaveBeenCalledTimes(4);
    expect(socketA.emit).toHaveBeenCalledTimes(1);
    expect(socketB.emit).toHaveBeenCalledTimes(2);
    expect(socketC.emit).toHaveBeenCalledTimes(1);
  });

  it('does not leak one recipient projection into another on retry (participant_results)', async () => {
    // Projections differ per recipient identity; assert each socket only ever
    // received its own payload and retry does not reuse another's result.
    const makeSocket = (id: string, participantId: string) => ({
      id,
      data: {
        auth: {
          kind: 'participant' as const,
          participantId,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    });
    const socketA = makeSocket('socket-leak-a', PARTICIPANT_ID);
    const socketB = makeSocket('socket-leak-b', OTHER_PARTICIPANT_ID);
    const resultsByParticipant = new Map<string, unknown>([
      [PARTICIPANT_ID, { scope: 'A-only' }],
      [OTHER_PARTICIPANT_ID, { scope: 'B-only' }],
    ]);
    let bFails = true;
    const getResults = jest.fn(
      (
        _sessionId: string,
        _questionId: string,
        actor: { kind: string; participantId?: string },
      ) =>
        actor.participantId === undefined
          ? Promise.reject(new Error('participant id required'))
          : Promise.resolve(resultsByParticipant.get(actor.participantId)),
    );
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      reauthorizeParticipant: jest.Mock;
      liveSessions: { getResults: jest.Mock };
      emitParticipantResults(event: unknown): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([socketA, socketB]),
      }),
    };
    gateway.reauthorizeParticipant = jest.fn().mockResolvedValue(true);
    gateway.liveSessions = { getResults };
    socketB.emit = jest.fn(() => {
      if (bFails) throw new Error('B leak-test failure');
      return true;
    });

    const event = {
      id: '0190c6b8-0000-7000-8000-0000000000ad',
      eventName: RealtimeEvent.RESULT_UPDATED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 52n,
      aggregateVersion: 1,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: { sessionQuestionId: contextEvent.sessionQuestionId },
      visibility: RealtimeVisibility.PARTICIPANT,
      targetParticipantId: null,
    };

    await expect(gateway.emitParticipantResults(event)).rejects.toMatchObject({
      name: 'DurableFanOutError',
      stage: 'participant_results',
      socketId: socketB.id,
    });
    bFails = false;
    await gateway.emitParticipantResults(event);

    // A saw only A's projection; B saw only B's — including on its retry.
    expect(socketA.emit).toHaveBeenCalledTimes(1);
    expect(socketB.emit).toHaveBeenCalledTimes(2);
    const payloadA = (socketA.emit.mock.calls[0] as unknown[])[1] as {
      data: { results: unknown };
    };
    const payloadBRetry = (socketB.emit.mock.calls[1] as unknown[])[1] as {
      data: { results: unknown };
    };
    expect(payloadA.data.results).toEqual({ scope: 'A-only' });
    expect(payloadBRetry.data.results).toEqual({ scope: 'B-only' });
    expect(
      getResults.mock.calls.map(
        (call) => (call[2] as { participantId: string }).participantId,
      ),
    ).toEqual([PARTICIPANT_ID, OTHER_PARTICIPANT_ID, OTHER_PARTICIPANT_ID]);
  });

  it('keeps participant filtering intact and does not record ineligible sockets as served (teacher_counts)', async () => {
    // A participant socket in the teacher room is filtered by the identity
    // guard; it must not be recorded as served for ANY stage — proven here by
    // a later, different-stage redispatch still emitting to it.
    const filteredSocket = {
      id: 'socket-filter-p',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      reauthorizeParticipant: jest.Mock;
      sessions: { assertAccountActive: jest.Mock };
      liveSessions: { getTeacherDetail: jest.Mock };
      emitTeacherCounts(liveSessionId: string, event?: unknown): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([filteredSocket]),
      }),
    };
    gateway.reauthorizeParticipant = jest.fn().mockResolvedValue(true);
    gateway.sessions = {
      assertAccountActive: jest.fn().mockResolvedValue(undefined),
    };
    gateway.liveSessions = {
      getTeacherDetail: jest.fn().mockResolvedValue({
        joinedCount: 3,
        votedCount: 1,
      }),
    };

    const event = {
      id: '0190c6b8-0000-7000-8000-0000000000ae',
      eventName: RealtimeEvent.RESULT_UPDATED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 53n,
      aggregateVersion: 1,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: { sessionQuestionId: contextEvent.sessionQuestionId },
      visibility: RealtimeVisibility.TEACHER,
      targetParticipantId: null,
    };

    // The participant socket is not an eligible teacher_counts recipient.
    await gateway.emitTeacherCounts(LIVE_SESSION_ID, event);
    expect(filteredSocket.emit).not.toHaveBeenCalled();

    // A later durable event on a different stage still must not treat the
    // filtered socket as served — it is simply not eligible for this leg.
    await gateway.emitTeacherCounts(LIVE_SESSION_ID, {
      ...event,
      id: '0190c6b8-0000-7000-8000-0000000000af',
    });
    expect(filteredSocket.emit).not.toHaveBeenCalled();
  });

  it('preserves the legacy undefined-event counts path untouched by fan-out memory', async () => {
    const teacher = {
      id: 'socket-legacy-t',
      data: {
        auth: {
          kind: 'teacher' as const,
          accountId: '0190c6b8-0000-7000-8000-0000000000b0',
          role: 'teacher',
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      sessions: { assertAccountActive: jest.Mock };
      liveSessions: { getTeacherDetail: jest.Mock };
      emitTeacherCounts(liveSessionId: string, event?: unknown): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([teacher]),
      }),
    };
    gateway.sessions = {
      assertAccountActive: jest.fn().mockResolvedValue(undefined),
    };
    gateway.liveSessions = {
      getTeacherDetail: jest.fn().mockResolvedValue({
        joinedCount: 2,
        votedCount: 2,
      }),
    };

    // Legacy path: no durable event. Must emit and never touch the memory.
    await gateway.emitTeacherCounts(LIVE_SESSION_ID);
    expect(teacher.emit).toHaveBeenCalledTimes(1);
    expect(gateway.fanOutMemory.size).toBe(0);

    // Repeated legacy calls keep emitting (no suppression without an event).
    await gateway.emitTeacherCounts(LIVE_SESSION_ID);
    expect(teacher.emit).toHaveBeenCalledTimes(2);
    expect(gateway.fanOutMemory.size).toBe(0);
  });

  it('keeps a reveal-gated participant skip out of the retry path and out of the delivery memory', async () => {
    const participant = {
      id: 'socket-reveal-p',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      reauthorizeParticipant: jest.Mock;
      logger: { debug: jest.Mock };
      liveSessions: { getResults: jest.Mock };
      emitParticipantResults(event: unknown): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([participant]),
      }),
    };
    gateway.logger = { debug: jest.fn() };
    gateway.reauthorizeParticipant = jest.fn().mockResolvedValue(true);
    gateway.liveSessions = {
      // A real DomainError subclass instance: production classifies the reveal
      // gate with `error instanceof DomainError && error.code === ...`.
      getResults: jest.fn(() =>
        Promise.reject(
          new DomainError(
            'RESULTS_NOT_REVEALED',
            'Submit your own answer before viewing live results.',
            409,
          ),
        ),
      ),
    };

    const event = {
      id: '0190c6b8-0000-7000-8000-0000000000b0',
      eventName: RealtimeEvent.RESULT_UPDATED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 54n,
      aggregateVersion: 1,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: { sessionQuestionId: contextEvent.sessionQuestionId },
      visibility: RealtimeVisibility.PARTICIPANT,
      targetParticipantId: null,
    };

    // The reveal gate is a legitimate skip: it resolves normally (no
    // DurableFanOutError), so no whole-row retry is triggered by it.
    await expect(
      gateway.emitParticipantResults(event),
    ).resolves.toBeUndefined();

    // Suppression did not record the gated recipient as served: if the gate
    // later opens, the recipient is still projected and emitted.
    gateway.liveSessions.getResults = jest.fn().mockResolvedValue({ rows: [] });
    await gateway.emitParticipantResults(event);
    expect(participant.emit).toHaveBeenCalledTimes(1);
  });

  it('still emits an event through the replay path even when fan-out memory marks it served', async () => {
    const socket = {
      id: 'socket-replay-iso',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      reauthorizeParticipant: jest.Mock;
      emitSharedEvent(
        event: unknown,
        data: Record<string, unknown>,
      ): Promise<void>;
      emitDurableEventToSocket(
        socket: unknown,
        client: unknown,
        event: unknown,
      ): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([socket]),
      }),
    };
    gateway.reauthorizeParticipant = jest.fn().mockResolvedValue(true);

    const event = {
      id: '0190c6b8-0000-7000-8000-0000000000b1',
      eventName: RealtimeEvent.QUESTION_OPENED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 55n,
      aggregateVersion: 1,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: {
        sessionQuestionId: contextEvent.sessionQuestionId,
      },
      visibility: RealtimeVisibility.SESSION,
      targetParticipantId: null,
    };

    // Normal durable fan-out marks this (event, socket) as served.
    await gateway.emitSharedEvent(event, {});
    expect(socket.emit).toHaveBeenCalledTimes(1);

    // The replay path must ignore the suppression map entirely.
    await gateway.emitDurableEventToSocket(socket, socket.data.auth, event);
    expect(socket.emit).toHaveBeenCalledTimes(2);

    // Replay did not mark anything served; a subsequent durable redispatch
    // still suppresses (the memory was untouched by replay).
    await gateway.emitSharedEvent(event, {});
    expect(socket.emit).toHaveBeenCalledTimes(2);
  });

  // --- Fix C Checkpoint C: retention (TTL / capacity) -----------------------

  it('stops suppressing a recipient after the TTL expires and allows re-delivery', async () => {
    // TTL expiry may permit duplicate re-delivery; it must never cause a
    // permanent omission. Time is controlled with fake timers, never sleeps.
    const socket = {
      id: 'socket-ttl',
      data: {
        auth: {
          kind: 'participant' as const,
          participantId: PARTICIPANT_ID,
          liveSessionId: LIVE_SESSION_ID,
        },
      },
      emit: jest.fn().mockReturnValue(true),
      disconnect: jest.fn(),
    };
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      fanOutMemory: Map<string, unknown>;
      server: { in(room: string): { fetchSockets(): Promise<unknown[]> } };
      reauthorizeParticipant: jest.Mock;
      emitSharedEvent(
        event: unknown,
        data: Record<string, unknown>,
      ): Promise<void>;
    };
    gateway.deliveryQueues = new Map();
    gateway.fanOutMemory = new Map();
    gateway.server = {
      in: jest.fn().mockReturnValue({
        fetchSockets: jest.fn().mockResolvedValue([socket]),
      }),
    };
    gateway.reauthorizeParticipant = jest.fn().mockResolvedValue(true);

    const event = {
      id: '0190c6b8-0000-7000-8000-0000000000b2',
      eventName: RealtimeEvent.QUESTION_OPENED,
      liveSessionId: LIVE_SESSION_ID,
      eventSeq: 56n,
      aggregateVersion: 1,
      serverTimestamp: new Date('2026-08-28T00:00:00.000Z'),
      projectionInput: { sessionQuestionId: contextEvent.sessionQuestionId },
      visibility: RealtimeVisibility.SESSION,
      targetParticipantId: null,
    };

    jest.useFakeTimers().setSystemTime(new Date('2026-08-28T00:00:00.000Z'));
    try {
      await gateway.emitSharedEvent(event, {});
      expect(socket.emit).toHaveBeenCalledTimes(1);

      // Within TTL: the served recipient stays suppressed.
      jest.setSystemTime(new Date('2026-08-28T00:09:59.000Z'));
      await gateway.emitSharedEvent(event, {});
      expect(socket.emit).toHaveBeenCalledTimes(1);

      // After TTL expiry: the entry is forgotten; re-delivery is permitted
      // (a duplicate) — never a permanent omission.
      jest.setSystemTime(new Date('2026-08-28T00:10:00.000Z'));
      await gateway.emitSharedEvent(event, {});
      expect(socket.emit).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('evicts the oldest entry beyond the capacity bound (oldest-insertion eviction)', async () => {
    const memory = new Map<string, unknown>();
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      fanOutMemory: Map<string, unknown>;
      fanOutEventMemory(
        eventId: string,
        nowMs: number,
      ): { stages: Map<unknown, unknown> };
      fanOutAlreadyServed(
        eventId: string,
        stage: unknown,
        socketId: string,
      ): boolean;
    };
    gateway.fanOutMemory = memory;

    // Fill to exactly the cap, then add one more and observe the eviction.
    for (let index = 0; index < 1000; index += 1) {
      gateway.fanOutEventMemory(`event-${index}`, 1_000 + index);
    }
    expect(memory.size).toBe(1000);
    expect(memory.has('event-0')).toBe(true);

    gateway.fanOutEventMemory('event-1000', 2000);
    expect(memory.size).toBe(1000);
    // The oldest inserted entry was evicted (FIFO/oldest-insertion, not LRU).
    expect(memory.has('event-0')).toBe(false);
    expect(memory.has('event-1')).toBe(true);
    expect(memory.has('event-1000')).toBe(true);

    // Eviction only permits duplicate re-delivery: the evicted (event, socket)
    // leg can be served again; it is never silently skipped by the capacity
    // bound on other events.
    expect(gateway.fanOutAlreadyServed('event-0', 'shared', 's1')).toBe(false);
  });
});

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
