import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { map, Observable } from 'rxjs';
import {
  createSuccessEnvelope,
  normalizeApiEnvelope,
  requestIdFrom,
} from './api-envelope';

/** Wrap versioned REST success values without changing controller contracts. */
@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    if (!isVersionedApiRequest(request)) return next.handle();

    const requestId = requestIdFrom(request);
    return next
      .handle()
      .pipe(
        map(
          (data: unknown) =>
            normalizeApiEnvelope(data, requestId) ??
            createSuccessEnvelope(data, requestId),
        ),
      );
  }
}

function isVersionedApiRequest(request: Request): boolean {
  const rawPath = request.originalUrl ?? request.url ?? '';
  const path = rawPath.split('?')[0];
  return path === '/api/v1' || path.startsWith('/api/v1/');
}
