import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma-app/client';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private clientInstance?: PrismaClient;

  constructor(private readonly config: ConfigService) {}

  get client(): PrismaClient {
    if (!this.clientInstance) {
      const connectionString = this.config.get<string>('DATABASE_URL');
      if (!connectionString) {
        throw new Error('DATABASE_URL is required for database access.');
      }
      this.clientInstance = new PrismaClient({
        adapter: new PrismaPg({ connectionString }),
      });
    }
    return this.clientInstance;
  }

  async onModuleDestroy(): Promise<void> {
    await this.clientInstance?.$disconnect();
  }
}
