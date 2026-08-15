import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * PrismaService — 封裝 PrismaClient 為可注入的 NestJS provider。
 *
 * Prisma 7 透過 adapter 連線（不再直接傳 url），
 * 連線字串由環境變數 DATABASE_URL 提供（見 .env.development）。
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly prisma: PrismaClient;

  constructor() {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
    this.prisma = new PrismaClient({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.prisma.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }

  get client(): PrismaClient {
    return this.prisma;
  }
}