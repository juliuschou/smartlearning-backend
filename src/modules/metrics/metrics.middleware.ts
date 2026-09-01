import type { NextFunction, Request, Response } from 'express';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    let recorded = false;

    const record = (statusCode: number): void => {
      if (recorded) return;
      recorded = true;
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      try {
        this.metrics.recordHttpRequest(
          request.method,
          matchedRoute(request),
          statusCode,
          durationSeconds,
        );
      } catch {
        // Metrics must never change response completion behavior.
      }
    };

    response.once('finish', () => record(response.statusCode));
    response.once('close', () => record(0));
    next();
  }
}

function matchedRoute(request: Request): string {
  const baseUrl = request.baseUrl;
  const routePath = (request as unknown as { route?: { path?: unknown } }).route
    ?.path;
  if (
    (baseUrl !== '' && !isSafePathPart(baseUrl)) ||
    typeof routePath !== 'string' ||
    !isSafePathPart(routePath)
  )
    return '__unmatched__';

  const combined = `${baseUrl}${routePath}`.replace(/^\/\//, '/');
  return isSafePathPart(combined) ? combined : '__unmatched__';
}

function isSafePathPart(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value.startsWith('/') &&
    !value.includes('?') &&
    !value.includes('#') &&
    !value.includes('*') &&
    !value.includes('{') &&
    !value.includes('}') &&
    !Array.from(value).some(
      (char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f,
    )
  );
}
