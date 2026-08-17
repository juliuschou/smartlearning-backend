import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { CliAuthContext } from '../../modules/identity/application/cli-credential.service';
import { CLI_AUTH_CONTEXT_KEY } from './cli-auth-context';

/**
 * Extract the CLI principal attached by `CliAuthGuard`. Throws if used on a
 * route not guarded by `CliAuthGuard` (mirrors `@CurrentAccount()` semantics).
 */
export const CurrentCliAccount = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CliAuthContext => {
    const request = ctx.switchToHttp().getRequest<{
      [CLI_AUTH_CONTEXT_KEY]?: CliAuthContext;
    }>();
    const principal = request[CLI_AUTH_CONTEXT_KEY];
    if (!principal) {
      throw new Error(
        'CurrentCliAccount used without CliAuthGuard on the route.',
      );
    }
    return principal;
  },
);
