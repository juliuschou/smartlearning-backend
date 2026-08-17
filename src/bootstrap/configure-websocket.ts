import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.IO adapter that injects a CORS allowlist read from `ConfigService`
 * at runtime. The `@WebSocketGateway({ cors })` decorator option is evaluated
 * at class-definition time and cannot reach DI/env, so we override
 * `createIOServer` instead and merge the env-derived origin list. Mirrors the
 * HTTP `enableCors` policy in `configureApplication` (credentials + explicit
 * origin allowlist; `*` is rejected by CSRF so it is treated as `true` here
 * only for dev parity, never in production).
 */
export class CorsIoAdapter extends IoAdapter {
  private readonly origins: boolean | string[];

  constructor(app: INestApplication) {
    super(app);
    const configService = app.get(ConfigService);
    const corsOrigin = configService.get<string>('CORS_ORIGIN') ?? '';
    this.origins =
      corsOrigin === '*'
        ? true
        : corsOrigin
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
    return server;
  }
}

/**
 * Attach the Socket.IO WebSocket adapter so `@WebSocketGateway()` controllers
 * bind to the HTTP server. Shared by production (`main.ts` via
 * `configureApplication`) and the e2e app factory so both paths stay identical.
 */
export function configureWebSocket(app: INestApplication): void {
  (app as NestExpressApplication).useWebSocketAdapter(new CorsIoAdapter(app));
}
