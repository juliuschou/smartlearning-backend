import { performance } from 'node:perf_hooks';
import { io, type Socket } from 'socket.io-client';
import type { OperationMetrics } from './metrics';

export interface RealtimeMessage {
  event?: string;
  eventSeq?: string;
  liveSessionId?: string;
  data?: Record<string, unknown>;
}

export class LoadSocketClient {
  private socket?: Socket;
  private lastEventSeq?: bigint;
  readonly messages: RealtimeMessage[] = [];

  constructor(
    private readonly baseUrl: string,
    private readonly sessionCode: string,
    private readonly participantToken: string,
    private readonly timeoutMs: number,
  ) {}

  connect(operation: OperationMetrics): Promise<void> {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const socket = io(`${this.baseUrl}/live`, {
        autoConnect: false,
        transports: ['websocket'],
        auth: {
          sessionCode: this.sessionCode,
          participantToken: this.participantToken,
        },
        reconnection: false,
        timeout: this.timeoutMs,
      });
      this.socket = socket;
      const timeout = setTimeout(() => {
        socket.disconnect();
        operation.timingsMs.push(performance.now() - started);
        operation.unexpectedErrorCount += 1;
        operation.errors.TIMEOUT = (operation.errors.TIMEOUT ?? 0) + 1;
        reject(new Error('Socket connection timed out.'));
      }, this.timeoutMs);
      socket.onAny((_name, payload: RealtimeMessage) => {
        if (!payload || typeof payload !== 'object') return;
        this.messages.push(payload);
        if (
          typeof payload.eventSeq === 'string' &&
          /^\d+$/.test(payload.eventSeq)
        ) {
          const next = BigInt(payload.eventSeq);
          if (this.lastEventSeq !== undefined && next < this.lastEventSeq) {
            operation.unexpectedErrorCount += 1;
            operation.errors.EVENT_SEQUENCE_REGRESSION =
              (operation.errors.EVENT_SEQUENCE_REGRESSION ?? 0) + 1;
          }
          this.lastEventSeq = next;
        }
      });
      socket.once('connect', () => {
        clearTimeout(timeout);
        operation.timingsMs.push(performance.now() - started);
        operation.successCount += 1;
        resolve();
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timeout);
        operation.timingsMs.push(performance.now() - started);
        operation.unexpectedErrorCount += 1;
        operation.errors[error.message || 'CONNECT_ERROR'] =
          (operation.errors[error.message || 'CONNECT_ERROR'] ?? 0) + 1;
        reject(error);
      });
      socket.connect();
    });
  }

  fetchSnapshot(): void {
    this.socket?.emit(
      'snapshot.fetch',
      this.lastEventSeq === undefined
        ? {}
        : { lastEventSeq: this.lastEventSeq.toString() },
    );
  }

  disconnect(): void {
    this.socket?.disconnect();
  }
}
