import { Controller, Get, VERSION_NEUTRAL, Version } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  checks: Record<
    string,
    { healthy: boolean; latencyMs?: number; error?: string }
  >;
}

/**
 * Liveness/readiness probes. `/health/live` is excluded from the /api/v1
 * prefix (see configureApplication) so orchestrators can reach it without
 * versioning concerns.
 *
 * - live: process is running. No dependency checks.
 * - ready: DB responds to `SELECT 1`. Redis readiness is added in Phase 7/9
 *   when the adapter is wired.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prismaService: PrismaService) {}

  @Get('live')
  @Version(VERSION_NEUTRAL)
  live(): HealthResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {},
    };
  }

  @Get('ready')
  @Get('ready')
  @Version(VERSION_NEUTRAL)
  async ready(): Promise<HealthResponse> {
    const checks: HealthResponse['checks'] = {};
    let dbHealthy = true;

    const start = Date.now();
    try {
      await this.prismaService.prisma.$queryRaw`SELECT 1`;
      checks.db = { healthy: true, latencyMs: Date.now() - start };
    } catch (error) {
      dbHealthy = false;
      checks.db = {
        healthy: false,
        error: error instanceof Error ? error.message : 'unknown error',
      };
    }

    return {
      status: dbHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}
