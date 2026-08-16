import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';
export const REQUEST_ID_PROPERTY = 'requestId';

/**
 * Stamps every request with a request ID (from inbound header or generated),
 * echoes it on the response, and attaches it to `req` for log enrichment.
 * Pino also picks up `req.id` via pino-http; we keep both names in sync.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: () => void): void {
    const inbound = req.get(REQUEST_ID_HEADER);
    const id =
      inbound && /^[A-Za-z0-9-]{1,128}$/.test(inbound) ? inbound : randomUUID();
    (req as unknown as Record<string, unknown>)[REQUEST_ID_PROPERTY] = id;
    (req as unknown as Record<string, unknown>).id = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  }
}
