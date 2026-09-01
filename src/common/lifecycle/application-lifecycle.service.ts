import { Injectable, type BeforeApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Server } from 'socket.io';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Coordinates the process boundary shared by HTTP, Socket.IO, and health
 * probes. It does not own domain state; PostgreSQL transactions remain the
 * authority for committed mutations.
 */
@Injectable()
export class ApplicationLifecycleService implements BeforeApplicationShutdown {
  private shuttingDown = false;
  private inFlight = 0;
  private socketServer?: Server;
  private shutdownDrains: Array<() => Promise<void> | void> = [];
  private drainWaiters: Array<() => void> = [];

  constructor(private readonly config: ConfigService) {}

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get inFlightRequests(): number {
    return this.inFlight;
  }

  registerSocketServer(server: Server): void {
    this.socketServer = server;
    if (this.shuttingDown) this.closeSockets();
  }

  registerShutdownDrain(drain: () => Promise<void> | void): void {
    this.shutdownDrains.push(drain);
  }

  /** Return a release callback, or false when the process is quiescing. */
  tryEnterRequest(): (() => void) | false {
    if (this.shuttingDown) return false;
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      if (this.inFlight === 0) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    };
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.closeSockets();
    await Promise.all([
      this.waitForDrain(this.shutdownTimeoutMs()),
      ...this.shutdownDrains.map((drain) => Promise.resolve().then(drain)),
    ]);
  }

  private closeSockets(): void {
    const namespace = this.socketServer?.of('/live');
    if (!namespace) return;

    for (const socket of namespace.sockets.values()) {
      socket.emit('server.shutdown', {
        code: 'SERVER_SHUTTING_DOWN',
        retryable: true,
      });
      socket.disconnect(true);
    }
  }

  private async waitForDrain(timeoutMs: number): Promise<void> {
    if (this.inFlight === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => this.drainWaiters.push(resolve)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.drainWaiters = [];
    }
  }

  private shutdownTimeoutMs(): number {
    const raw = this.config.get<string | number>('SHUTDOWN_TIMEOUT_MS');
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }
}
