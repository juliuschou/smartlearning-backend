import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RateLimitedError } from '../../common/errors';
import { OperationRateLimiterService } from './operation-rate-limiter.service';
import {
  OPERATION_RATE_LIMIT_POLICY_KEY,
  OperationRateLimitPolicy,
} from './operation-rate-limit';

interface CliRateLimitActor {
  kind: 'web' | 'cli';
  cliCredentialId?: string;
}

@Injectable()
export class OperationRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: OperationRateLimiterService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const policy = this.reflector.getAllAndOverride<OperationRateLimitPolicy>(
      OPERATION_RATE_LIMIT_POLICY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!policy) return true;

    const request = context.switchToHttp().getRequest<
      Request & {
        courseActor?: CliRateLimitActor;
        batchActor?: CliRateLimitActor;
      }
    >();
    const actor = request.courseActor ?? request.batchActor;
    if (!actor) {
      throw new Error(
        'OperationRateLimitGuard requires an authenticated Course or batch actor.',
      );
    }
    if (actor.kind === 'web') return true;
    if (!actor.cliCredentialId) {
      throw new Error('CLI actor is missing cliCredentialId.');
    }

    const decision = this.limiter.consume(policy, actor.cliCredentialId);
    if (decision.limited) {
      throw new RateLimitedError(decision.retryAfterSeconds);
    }
    return true;
  }
}
