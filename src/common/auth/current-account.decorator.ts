import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthContext } from './auth-context';

/**
 * Extract the authenticated AuthContext placed on the request by SessionGuard.
 * Throws if used on a route not guarded by SessionGuard.
 */
export const CurrentAccount = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<{
      authContext?: AuthContext;
    }>();
    if (!req.authContext) {
      throw new Error('CurrentAccount used without SessionGuard on the route');
    }
    return req.authContext;
  },
);
