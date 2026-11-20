import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../../generated/prisma-app/client';
import { createPgAdapterFactory, PrismaService } from './prisma.service';

type PrismaClientLifecycleMock = Pick<
  PrismaClient,
  '$connect' | '$disconnect'
> & {
  $queryRaw: jest.Mock;
};

describe('PrismaService', () => {
  const connectionString = 'postgresql://user:pass@localhost:5432/test';
  let config: ConfigService;
  let service: PrismaService;

  beforeEach(() => {
    config = {
      get: jest.fn().mockReturnValue(connectionString),
    } as unknown as ConfigService;
    service = new PrismaService(config);
  });

  it('connects and probes the database during module initialization', async () => {
    const client: PrismaClientLifecycleMock = {
      $connect: jest.fn().mockResolvedValue(undefined),
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    };
    service['clientInstance'] = client as unknown as PrismaClient;

    await service.onModuleInit();

    expect(client.$connect).toHaveBeenCalledTimes(1);
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('fails startup safely when the database probe fails', async () => {
    const client: PrismaClientLifecycleMock = {
      $connect: jest.fn().mockResolvedValue(undefined),
      $queryRaw: jest.fn().mockRejectedValue(new Error(connectionString)),
      $disconnect: jest.fn().mockRejectedValue(new Error(connectionString)),
    };
    service['clientInstance'] = client as unknown as PrismaClient;

    let startupError: unknown;
    try {
      await service.onModuleInit();
    } catch (error) {
      startupError = error;
    }

    expect(startupError).toBeInstanceOf(Error);
    expect((startupError as Error).message).toBe(
      'Database connection failed during startup. Check database availability and DATABASE_URL configuration.',
    );
    expect((startupError as Error).message).not.toContain(connectionString);
    expect(client.$connect).toHaveBeenCalledTimes(1);
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
    expect(client.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('fails startup when DATABASE_URL is missing', async () => {
    (config.get as jest.Mock).mockReturnValue(undefined);

    await expect(service.onModuleInit()).rejects.toThrow(
      'DATABASE_URL is required for database access.',
    );
  });

  it('configures a bounded connection timeout for the pg adapter', () => {
    const adapter = createPgAdapterFactory(connectionString);
    const config = (
      adapter as unknown as {
        config: { connectionString: string; connectionTimeoutMillis: number };
      }
    ).config;
    expect(config.connectionString).toBe(connectionString);
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(config.connectionTimeoutMillis).toBeLessThanOrEqual(15000);
  });

  it('disconnects an instantiated client during module destruction', async () => {
    const client: PrismaClientLifecycleMock = {
      $connect: jest.fn().mockResolvedValue(undefined),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    };
    service['clientInstance'] = client as unknown as PrismaClient;

    await service.onModuleDestroy();

    expect(client.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not instantiate or disconnect a client during destruction if unused', async () => {
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(config.get).not.toHaveBeenCalled();
  });
});
