import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitedError } from '../../common/errors';
import { OperationRateLimitGuard } from './operation-rate-limit.guard';
import {
  OperationRateLimitPolicy,
  OPERATION_RATE_LIMIT_POLICY_KEY,
} from './operation-rate-limit';
import { OperationRateLimiterService } from './operation-rate-limiter.service';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => contextFor,
    getClass: () => OperationRateLimitGuard,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function makeGuard(
  consume: jest.Mock,
  policy: OperationRateLimitPolicy = OperationRateLimitPolicy.CLI_COURSES_LIST,
) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(policy),
  } as unknown as Reflector;
  const limiter = { consume } as unknown as OperationRateLimiterService;
  return new OperationRateLimitGuard(reflector, limiter);
}

describe('OperationRateLimitGuard', () => {
  it('bypasses the operation bucket for Web actors', () => {
    const consume = jest.fn();
    const guard = makeGuard(consume);

    expect(
      guard.canActivate(contextFor({ courseActor: { kind: 'web' } })),
    ).toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it('throws the limited error returned by the CLI operation bucket', () => {
    const consume = jest.fn().mockReturnValue({
      limited: true,
      retryAfterSeconds: 9,
    });
    const guard = makeGuard(consume);

    let thrown: unknown;
    try {
      guard.canActivate(
        contextFor({
          batchActor: { kind: 'cli', cliCredentialId: 'cred-1' },
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect((thrown as RateLimitedError).retryAfterSeconds).toBe(9);
    expect(consume).toHaveBeenCalledWith(
      OperationRateLimitPolicy.CLI_COURSES_LIST,
      'cred-1',
    );
  });

  it('fails closed when no authenticated Course or batch actor exists', () => {
    const consume = jest.fn();
    const guard = makeGuard(consume);

    expect(() => guard.canActivate(contextFor({}))).toThrow(
      'OperationRateLimitGuard requires an authenticated Course or batch actor.',
    );
    expect(consume).not.toHaveBeenCalled();
  });

  it('fails closed when a CLI actor has no credential id', () => {
    const consume = jest.fn();
    const guard = makeGuard(consume);

    expect(() =>
      guard.canActivate(contextFor({ courseActor: { kind: 'cli' } })),
    ).toThrow('CLI actor is missing cliCredentialId.');
    expect(consume).not.toHaveBeenCalled();
  });

  it('reads the operation policy from handler/class metadata', () => {
    const consume = jest.fn().mockReturnValue({
      limited: false,
      retryAfterSeconds: 0,
    });
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValue(OperationRateLimitPolicy.CLI_BATCH_CONFIRM),
    } as unknown as Reflector;
    const guard = new OperationRateLimitGuard(reflector, {
      consume,
    } as unknown as OperationRateLimiterService);

    expect(
      guard.canActivate(
        contextFor({
          courseActor: { kind: 'cli', cliCredentialId: 'cred-1' },
        }),
      ),
    ).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      OPERATION_RATE_LIMIT_POLICY_KEY,
      expect.any(Array),
    );
    expect(consume).toHaveBeenCalledWith(
      OperationRateLimitPolicy.CLI_BATCH_CONFIRM,
      'cred-1',
    );
  });
});
