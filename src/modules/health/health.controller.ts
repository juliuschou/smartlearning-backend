import { Controller, Get, Res, VERSION_NEUTRAL, Version } from '@nestjs/common';
import type { Response } from 'express';
import { ReadinessService } from './readiness.service';

interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  checks: Record<
    string,
    {
      healthy: boolean;
      latencyMs?: number;
      mode?: string;
      adapter?: string;
      readiness?: string;
      error?: string;
    }
  >;
}

/**
 * Liveness/readiness probes. `/health/live` is excluded from the /api/v1
 * prefix (see configureApplication) so orchestrators can reach it without
 * versioning concerns.
 *
 * - live: process is running. No dependency checks.
 * - ready: PostgreSQL is reachable and the configured realtime Redis policy is
 *   satisfied. Optional Redis fallback remains HTTP 200 but reports degraded.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

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
  @Version(VERSION_NEUTRAL)
  async ready(@Res({ passthrough: true }) response: Response) {
    const result = await this.readiness.check();
    response.status(result.httpStatus);
    const { httpStatus: _httpStatus, ...health } = result;
    return health;
  }
}
