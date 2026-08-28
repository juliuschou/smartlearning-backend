import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Server, ServerOptions } from 'socket.io';
import { RealtimeRedisService } from '../modules/realtime/realtime-redis.service';

/**
 * Socket.IO adapter that injects a CORS allowlist read from `ConfigService`
 * at runtime. The `@WebSocketGateway({ cors })` decorator option is evaluated
 * at class-definition time and cannot reach DI/env, so we override
 * `createIOServer` instead and merge the env-derived origin list. Mirrors the
 * HTTP `enableCors` policy in `configureApplication` (credentials + explicit
 * origin allowlist).
 */
export class CorsIoAdapter extends IoAdapter {
  private readonly origins: string[];

  constructor(
    app: INestApplication,
    private readonly redis: RealtimeRedisService,
  ) {
    super(app);
    const configService = app.get(ConfigService);
    const corsOrigin = configService.get<string>('CORS_ORIGIN') ?? '';
    this.origins = corsOrigin
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  createIOServer(
    port: number,
    options?: ServerOptions & { namespace?: string },
  ): Server {
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: this.origins,
        credentials: true,
      },
    });
    this.redis.bindServer(server);
    return server;
  }
}

/**
 * Attach the Socket.IO WebSocket adapter so `@WebSocketGateway()` controllers
 * bind to the HTTP server. Shared by production (`main.ts` via
 * `configureApplication`) and the e2e app factory so both paths stay identical.
 */
export async function configureWebSocket(app: INestApplication): Promise<void> {
  const redis = app.get(RealtimeRedisService);
  await redis.initialize();
  (app as NestExpressApplication).useWebSocketAdapter(
    new CorsIoAdapter(app, redis),
  );
}
