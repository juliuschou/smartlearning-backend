import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma-app/client';

// An unresponsive PostgreSQL endpoint (e.g. a stopped container that drops
// rather than refuses connections) never completes the pg handshake. Pool
// connections default to waiting forever, so the startup probe must fail
// within a bounded time for fail-fast startup to work at all.
export const DATABASE_CONNECTION_TIMEOUT_MS = 5000;

export function createPgAdapterFactory(connectionString: string): PrismaPg {
  return new PrismaPg({
    connectionString,
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
  });
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private clientInstance?: PrismaClient;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const client = this.client;
    try {
      await client.$connect();
      await client.$queryRaw`SELECT 1`;
    } catch {
      try {
        await client.$disconnect();
      } catch {
        // Preserve the startup failure; cleanup errors must not hide it.
      }
      throw new Error(
        'Database connection failed during startup. Check database availability and DATABASE_URL configuration.',
      );
    }
  }

  get client(): PrismaClient {
    if (!this.clientInstance) {
      const connectionString = this.config.get<string>('DATABASE_URL');
      if (!connectionString) {
        throw new Error('DATABASE_URL is required for database access.');
      }
      this.clientInstance = new PrismaClient({
        adapter: createPgAdapterFactory(connectionString),
      });
    }
    return this.clientInstance;
  }

  async onModuleDestroy(): Promise<void> {
    await this.clientInstance?.$disconnect();
  }
}
