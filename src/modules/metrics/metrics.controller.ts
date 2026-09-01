import { Controller, Get, Res, VERSION_NEUTRAL, Version } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Version(VERSION_NEUTRAL)
  async scrape(
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const registry = this.metrics.getRegistry();
    response.setHeader('Content-Type', registry.contentType);
    return registry.metrics();
  }
}
