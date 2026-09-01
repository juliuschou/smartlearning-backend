import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, type RedisClientType } from 'redis';
import type { Server } from 'socket.io';
import {
  parseRealtimeRedisMode,
  resolveRealtimeRedisPolicy,
  RealtimeRedisMode,
  type RedisAvailability,
  type RealtimeRedisPolicy,
} from './live-session-realtime-contract';

const REDIS_CONNECT_TIMEOUT_MS = 2_000;
const REDIS_ADAPTER_KEY = 'smartlearning:socket.io';
const REDIS_RETRY_INITIAL_MS = 1_000;
const REDIS_RETRY_MAX_MS = 30_000;

type RedisClient = RedisClientType;
type SocketIoNamespace = ReturnType<Server['of']>;
type SocketIoAdapter = SocketIoNamespace['adapter'];
type SocketIoAdapterLifecycle = SocketIoAdapter & {
  close?: () => Promise<void> | void;
};
type SocketIoAdapterFactory = ReturnType<typeof createAdapter>;
type SocketIoAdapterConstructor = new (
  namespace: SocketIoNamespace,
) => SocketIoAdapter;
type SocketIoAdapterFunction = (
  namespace: SocketIoNamespace,
) => SocketIoAdapter;

/**
 * Owns the optional Socket.IO Redis fan-out clients. PostgreSQL remains the
 * authorization and domain-data authority; Redis is never used for reads.
 */
@Injectable()
export class RealtimeRedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeRedisService.name);
  private readonly mode: RealtimeRedisMode;
  private publisher?: RedisClient;
  private subscriber?: RedisClient;
  private available = false;
  private initializing?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;
  private retryAttempt = 0;
  private stopped = false;
  private socketServer?: Server;
  private localAdapter?: SocketIoAdapterFactory;
  private activeAdapter: 'local' | 'redis' = 'local';
  private readonly adapterClosePromises = new Set<Promise<void>>();

  constructor(private readonly config: ConfigService) {
    this.mode = parseRealtimeRedisMode(
      this.config.get<string>('REALTIME_REDIS_MODE'),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.close();
  }

  get redisMode(): RealtimeRedisMode {
    return this.mode;
  }

  get availability(): RedisAvailability {
    return this.available ? 'available' : 'unavailable';
  }

  get policy(): RealtimeRedisPolicy {
    return resolveRealtimeRedisPolicy(this.mode, this.availability);
  }

  get acceptsTraffic(): boolean {
    return this.policy.acceptsTraffic;
  }

  /** Connect before Nest initializes Socket.IO gateways; retry after outages. */
  async initialize(): Promise<void> {
    if (this.stopped || this.mode === RealtimeRedisMode.OFF) return;
    if (this.available) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.connect();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
    if (!this.available) this.scheduleReconnect();
  }

  getAdapterFactory(): SocketIoAdapterFactory | undefined {
    if (!this.available || !this.publisher || !this.subscriber)
      return undefined;
    return createAdapter(this.publisher, this.subscriber, {
      key: REDIS_ADAPTER_KEY,
    }) as unknown as SocketIoAdapterFactory;
  }

  /** Bind the Socket.IO server so adapter changes follow Redis availability. */
  bindServer(server: Server): void {
    this.socketServer = server;
    this.localAdapter = server.adapter() as SocketIoAdapterFactory;
    this.applyAdapter();
  }

  async close(): Promise<void> {
    this.available = false;
    this.applyAdapter();
    const clients = [this.publisher, this.subscriber];
    this.publisher = undefined;
    this.subscriber = undefined;
    await Promise.all([...this.adapterClosePromises]);
    await Promise.all(
      clients.map(async (client) => {
        if (!client?.isOpen) return;
        try {
          await client.close();
        } catch (error) {
          this.logger.debug(
            { err: error instanceof Error ? error.name : 'unknown' },
            'Redis client close failed',
          );
        }
      }),
    );
  }

  private async connect(): Promise<void> {
    if (this.mode === RealtimeRedisMode.OFF) {
      this.available = false;
      return;
    }
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.logUnavailable('missing_url');
      return;
    }

    const publisher = this.createClient(url);
    const subscriber = publisher.duplicate();
    this.publisher = publisher;
    this.subscriber = subscriber;
    const connectPromise = Promise.all([
      publisher.connect(),
      subscriber.connect(),
    ]);
    try {
      await withTimeout(connectPromise, REDIS_CONNECT_TIMEOUT_MS);
      if (!publisher.isReady || !subscriber.isReady) {
        this.logUnavailable('not_ready');
        await this.close();
        return;
      }
      this.available = true;
      this.retryAttempt = 0;
      this.applyAdapter();
      this.logger.log({ mode: this.mode }, 'Realtime Redis adapter ready');
    } catch (error) {
      this.logUnavailable(
        error instanceof Error ? error.name : 'connect_error',
      );
      await this.close();
    }
  }

  private createClient(url: string): RedisClient {
    const client = createClient({
      url,
      socket: {
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        reconnectStrategy: (retries) => Math.min(1_000, 100 * (retries + 1)),
      },
    });
    client.on('error', (error) => {
      this.available = false;
      this.applyAdapter();
      this.logger.debug(
        {
          mode: this.mode,
          err: error instanceof Error ? error.name : 'unknown',
        },
        'Realtime Redis client error',
      );
    });
    client.on('ready', () => {
      if (this.publisher?.isReady && this.subscriber?.isReady) {
        this.available = true;
        this.retryAttempt = 0;
        this.applyAdapter();
      }
    });
    client.on('end', () => {
      this.available = false;
      this.applyAdapter();
      this.scheduleReconnect();
    });
    return client;
  }

  private scheduleReconnect(): void {
    if (
      this.stopped ||
      this.mode === RealtimeRedisMode.OFF ||
      this.retryTimer ||
      !this.config.get<string>('REDIS_URL')
    ) {
      return;
    }
    const delay = Math.min(
      REDIS_RETRY_MAX_MS,
      REDIS_RETRY_INITIAL_MS * 2 ** this.retryAttempt,
    );
    this.retryAttempt = Math.min(this.retryAttempt + 1, 5);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.initialize().catch((error) => {
        this.logger.warn(
          {
            mode: this.mode,
            err: error instanceof Error ? error.name : 'unknown',
          },
          'Realtime Redis reconnect attempt failed',
        );
      });
    }, delay);
  }

  private applyAdapter(): void {
    if (!this.socketServer || !this.localAdapter) return;
    const redisAdapter = this.getAdapterFactory();
    const nextAdapter = redisAdapter ?? this.localAdapter;
    const nextKind = redisAdapter ? 'redis' : 'local';
    if (this.activeAdapter === nextKind) return;

    const liveNamespace = this.socketServer.of('/live');
    const roomMemberships = [...liveNamespace.sockets.values()].map(
      (socket) => ({
        socketId: socket.id,
        rooms: new Set(socket.rooms),
      }),
    );
    const previousAdapter = liveNamespace.adapter as SocketIoAdapterLifecycle;
    this.closeAdapter(previousAdapter);
    this.socketServer.adapter(nextAdapter);
    liveNamespace.adapter = createSocketIoAdapter(nextAdapter, liveNamespace);
    for (const membership of roomMemberships) {
      liveNamespace.adapter.addAll(membership.socketId, membership.rooms);
    }
    this.activeAdapter = nextKind;
  }

  private closeAdapter(adapter: SocketIoAdapterLifecycle): void {
    if (typeof adapter.close !== 'function') return;
    const closePromise = Promise.resolve()
      .then(() => adapter.close?.())
      .catch((error: unknown) => {
        this.logger.debug(
          { err: error instanceof Error ? error.name : 'unknown' },
          'Socket.IO adapter close failed',
        );
      })
      .then(() => undefined);
    this.adapterClosePromises.add(closePromise);
    void closePromise.finally(() =>
      this.adapterClosePromises.delete(closePromise),
    );
  }

  private logUnavailable(reason: string): void {
    this.available = false;
    this.applyAdapter();
    this.logger.warn({ mode: this.mode, reason }, 'Realtime Redis unavailable');
  }
}

function createSocketIoAdapter(
  factory: SocketIoAdapterFactory,
  namespace: SocketIoNamespace,
): SocketIoAdapter {
  const callable = factory as unknown as
    SocketIoAdapterConstructor | SocketIoAdapterFunction;
  if (Object.prototype.hasOwnProperty.call(factory, 'prototype')) {
    return new (callable as SocketIoAdapterConstructor)(namespace);
  }
  return (callable as SocketIoAdapterFunction)(namespace);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('REDIS_CONNECT_TIMEOUT')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
