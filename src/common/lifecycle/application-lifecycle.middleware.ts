import { Injectable } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ServerShuttingDownError } from '../errors';
import { ApplicationLifecycleService } from './application-lifecycle.service';

const ALLOWED_DURING_SHUTDOWN = new Set([
  '/health/live',
  '/health/ready',
  '/metrics',
]);

/** Reject new application work once shutdown has begun. */
@Injectable()
export class ApplicationLifecycleMiddleware {
  constructor(private readonly lifecycle: ApplicationLifecycleService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    if (this.lifecycle.isShuttingDown) {
      if (ALLOWED_DURING_SHUTDOWN.has(request.path)) {
        next();
      } else {
        next(new ServerShuttingDownError());
      }
      return;
    }

    const release = this.lifecycle.tryEnterRequest();
    if (release === false) {
      next(new ServerShuttingDownError());
      return;
    }

    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };
    response.once('finish', releaseOnce);
    response.once('close', releaseOnce);
    next();
  }
}
