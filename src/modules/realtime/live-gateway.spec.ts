import { LiveGateway } from './live-gateway';
import { SESSION_COOKIE_NAME } from '../../common/security';
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

  it('serializes concurrent snapshot.fetch calls per socket', async () => {
    const gateway = Object.create(LiveGateway.prototype) as unknown as {
      deliveryQueues: Map<string, Promise<void>>;
      redis: { acceptsTraffic: boolean };
      onSnapshotFetch(socket: unknown, body: unknown): Promise<void>;
      replayOrSnapshot: jest.Mock;
    };
    gateway.deliveryQueues = new Map();
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
