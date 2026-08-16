import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * PrismaService — wraps the generated PrismaClient as an injectable provider.
 *
 * Prisma 7 connects via adapter (no direct url); the connection string is read
 * from the validated ConfigService (env schema) rather than process.env, so the
 * whole app shares one validated configuration source.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly prisma: PrismaClient;

  constructor(configService: ConfigService) {
    const connectionString = configService.get<string>('DATABASE_URL');
    if (!connectionString) {
      // Env validation should have caught this, but fail loudly either way.
      throw new Error('DATABASE_URL is not configured');
    }
    const adapter = new PrismaPg({ connectionString });
    this.prisma = new PrismaClient({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.prisma.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }

  /** Convenience accessor for call sites that want the typed client. */
  get client(): PrismaClient {
    return this.prisma;
  }
}
