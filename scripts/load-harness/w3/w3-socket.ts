/**
 * W3 realtime client — a receipt-recording Socket.IO client built for the
 * result-broadcast correctness question ("who actually received what").
 *
 * Differences from `scripts/load-harness/socket-client.ts` (W1/W2), which W3
 * deliberately does NOT reuse or modify:
 *   - every event is recorded WITH its Socket.IO event name (W2 discarded it);
 *   - each receipt carries a monotonic `receivedAtMs` (run-relative) and a
 *     wall-clock ISO stamp, so commit→receipt can be measured;
 *   - the full connect / disconnect / connect_error timeline is captured, so a
 *     missing receipt can be classified SOCKET LOST vs CLIENT NOT RECEIVED;
 *   - a `waitFor` primitive resolves on correlation keys (eventSeq / eventName),
 *     never on timing proximity;
 *   - a teacher variant sends the web-session cookie in the handshake headers,
 *     because Socket.IO parses its own handshake before Express `cookie-parser`.
 *
 * Read-only with respect to the application: it only connects a socket, listens,
 * and (optionally) emits `snapshot.fetch` on explicit request.
 */
import { performance } from 'node:perf_hooks';
import { io, type Socket } from 'socket.io-client';

export interface SocketReceipt {
  eventName: string;
  payload: Record<string, unknown>;
  /** performance.now() relative to the run start passed to the constructor. */
  receivedAtMs: number;
  /** Wall-clock receive time (ISO) for cross-correlation with DB timestamps. */
  receivedAtIso: string;
  /** Server-stamped fields lifted off the envelope, when present. */
  eventSeq?: string;
  aggregateVersion?: number;
  serverTimestamp?: string;
  liveSessionId?: string;
  visibility?: string;
}

export type SocketLifecycleKind =
  'connect' | 'disconnect' | 'connect_error' | 'reconnect_attempt';

export interface SocketLifecycleEntry {
  kind: SocketLifecycleKind;
  atMs: number;
  atIso: string;
  detail?: string;
}

/** Correlation predicate for `waitFor`. All provided fields must match. */
export interface ReceiptMatch {
  eventName?: string;
  eventSeq?: string;
  liveSessionId?: string;
  aggregateVersion?: number;
}

interface ClientOptions {
  baseUrl: string;
  runStartMs: number;
  timeoutMs: number;
  /** Participant handshake. */
  sessionCode?: string;
  participantToken?: string;
  /** Teacher handshake: raw Cookie header + live session id. */
  cookieHeader?: string;
  liveSessionId?: string;
}

export class W3SocketClient {
  readonly receipts: SocketReceipt[] = [];
  readonly lifecycle: SocketLifecycleEntry[] = [];
  /** Socket.IO id, available after `connect` resolves. */
  socketId?: string;
  connectedAtMs?: number;
  connectedAtIso?: string;
  connectError?: string;
  /** Run-relative ms when the any-listener was armed (before connect). */
  listenerArmedAtMs?: number;

  /** True when the listener was armed after connect resolved (race risk). */
  get listenerArmedAfterConnect(): boolean {
    return (
      this.listenerArmedAtMs !== undefined &&
      this.connectedAtMs !== undefined &&
      this.listenerArmedAtMs > this.connectedAtMs
    );
  }

  private socket?: Socket;
  private waiter?: {
    match: ReceiptMatch;
    resolve: (receipt: SocketReceipt) => void;
  };

  constructor(
    private readonly label: string,
    private readonly options: ClientOptions,
  ) {}

  get isConnected(): boolean {
    return this.socket?.connected === true;
  }

  /** True once the socket has connected and never disconnected/errored. */
  get everConnected(): boolean {
    return this.connectedAtMs !== undefined;
  }

  get hasDisconnected(): boolean {
    return this.lifecycle.some((entry) => entry.kind === 'disconnect');
  }

  connect(): Promise<void> {
    const { baseUrl, timeoutMs, runStartMs } = this.options;
    const now = () => ({
      atMs: performance.now() - runStartMs,
      atIso: new Date().toISOString(),
    });
    return new Promise((resolve, reject) => {
      const socket = io(`${baseUrl}/live`, {
        autoConnect: false,
        transports: ['websocket'],
        reconnection: false,
        timeout: timeoutMs,
        ...(this.options.cookieHeader
          ? {
              // Teacher: handshake cookie (Socket.IO reads cookies itself).
              extraHeaders: { Cookie: this.options.cookieHeader },
              auth: { liveSessionId: this.options.liveSessionId ?? '' },
            }
          : {
              auth: {
                sessionCode: this.options.sessionCode ?? '',
                participantToken: this.options.participantToken ?? '',
              },
            }),
      });
      this.socket = socket;
      // Arm the any-listener BEFORE connect so a dispatch that races the
      // connect cannot be lost (the W2 lesson). Recorded so a missing receipt
      // can be attributed to a harness race rather than asserted as a client miss.
      this.listenerArmedAtMs = performance.now() - runStartMs;
      const timer = setTimeout(() => {
        socket.disconnect();
        this.connectError = 'TIMEOUT';
        this.lifecycle.push({
          kind: 'connect_error',
          ...now(),
          detail: 'TIMEOUT',
        });
        reject(new Error(`${this.label}: socket connection timed out.`));
      }, timeoutMs);

      socket.onAny((eventName: string, payload: unknown) => {
        if (!payload || typeof payload !== 'object') return;
        const record = payload as Record<string, unknown>;
        const at = now();
        const receipt: SocketReceipt = {
          eventName,
          payload: record,
          receivedAtMs: at.atMs,
          receivedAtIso: at.atIso,
          eventSeq:
            typeof record.eventSeq === 'string' ? record.eventSeq : undefined,
          aggregateVersion:
            typeof record.aggregateVersion === 'number'
              ? record.aggregateVersion
              : undefined,
          serverTimestamp:
            typeof record.serverTimestamp === 'string'
              ? record.serverTimestamp
              : undefined,
          liveSessionId:
            typeof record.liveSessionId === 'string'
              ? record.liveSessionId
              : undefined,
          visibility:
            typeof record.visibility === 'string'
              ? record.visibility
              : undefined,
        };
        this.receipts.push(receipt);
        if (this.waiter && matches(receipt, this.waiter.match)) {
          const resolveWaiter = this.waiter.resolve;
          this.waiter = undefined;
          resolveWaiter(receipt);
        }
      });

      socket.on('connect', () => {
        clearTimeout(timer);
        this.socketId = socket.id;
        this.connectedAtMs = performance.now() - runStartMs;
        this.connectedAtIso = new Date().toISOString();
        this.lifecycle.push({ kind: 'connect', ...now() });
        resolve();
      });
      socket.on('disconnect', (reason: string) => {
        this.lifecycle.push({ kind: 'disconnect', ...now(), detail: reason });
      });
      socket.on('connect_error', (error: Error) => {
        this.connectError = error.message || 'CONNECT_ERROR';
        this.lifecycle.push({
          kind: 'connect_error',
          ...now(),
          detail: this.connectError,
        });
      });
      socket.connect();
    });
  }

  /** Resolves with the first receipt matching `match`, or `undefined` on timeout. */
  waitFor(
    match: ReceiptMatch,
    timeoutMs: number,
  ): Promise<SocketReceipt | undefined> {
    const existing = this.receipts.find((receipt) => matches(receipt, match));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiter?.match === match) this.waiter = undefined;
        resolve(undefined);
      }, timeoutMs);
      this.waiter = {
        match,
        resolve: (receipt) => {
          clearTimeout(timer);
          resolve(receipt);
        },
      };
    });
  }

  fetchSnapshot(): void {
    const last = this.receipts
      .map((receipt) => receipt.eventSeq)
      .filter((seq): seq is string => typeof seq === 'string')
      .pop();
    this.socket?.emit(
      'snapshot.fetch',
      last === undefined ? {} : { lastEventSeq: last },
    );
  }

  disconnect(): void {
    this.socket?.disconnect();
  }
}

function matches(receipt: SocketReceipt, match: ReceiptMatch): boolean {
  if (match.eventName !== undefined && receipt.eventName !== match.eventName)
    return false;
  if (match.eventSeq !== undefined && receipt.eventSeq !== match.eventSeq)
    return false;
  if (
    match.liveSessionId !== undefined &&
    receipt.liveSessionId !== match.liveSessionId
  )
    return false;
  if (
    match.aggregateVersion !== undefined &&
    receipt.aggregateVersion !== match.aggregateVersion
  )
    return false;
  return true;
}
