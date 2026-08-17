import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from './session.guard';
import {
  CliAuthGuard,
  CLI_KEY_HEADER,
} from '../../modules/identity/api/cli-auth.guard';
import { CLI_AUTH_CONTEXT_KEY, type CliAuthContext } from './cli-auth-context';
import type { AuthContext } from './auth-context';

/**
 * Unified batch actor principal attached by BatchActorGuard. `kind` records
 * which authentication path succeeded so the service can compute actorScope
 * and bind the validation token to a CLI credential when applicable.
 */
export interface BatchActorContext {
  kind: 'web' | 'cli';
  accountId: string;
  role: string;
  cliCredentialId?: string;
}

export const BATCH_ACTOR_KEY = 'batchActor';

declare module 'express' {
  interface Request {
    batchActor?: BatchActorContext;
  }
}

/**
 * Accept either a Web session cookie or an `X-CLI-Key` header for batch
 * validate/confirm. CLI requests do NOT require CSRF (trust boundary is the
 * credential header). Web requests are handed to SessionGuard; the controller
 * applies CsrfGuard on Web mutation routes separately when needed.
 *
 * On success attaches `req.batchActor` (and the underlying authContext/
 * cliAuthContext for downstream decorators).
 */
@Injectable()
export class BatchActorGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionGuard,
    private readonly cliAuth: CliAuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      Request & {
        authContext?: AuthContext;
        [CLI_AUTH_CONTEXT_KEY]?: CliAuthContext;
      }
    >();
    const cliKey = request.headers[CLI_KEY_HEADER] as string | undefined;
    if (cliKey) {
      await this.cliAuth.canActivate(context);
      const cli = request[CLI_AUTH_CONTEXT_KEY];
      if (!cli) return false;
      request[BATCH_ACTOR_KEY] = {
        kind: 'cli',
        accountId: cli.account.id,
        role: cli.account.role,
        cliCredentialId: cli.credentialId,
      };
      return true;
    }
    await this.sessions.canActivate(context);
    const auth = request.authContext;
    if (!auth) return false;
    request[BATCH_ACTOR_KEY] = {
      kind: 'web',
      accountId: auth.account.id,
      role: auth.account.role,
    };
    return true;
  }
}

/** Extractor decorator for the batch actor principal. */
export { CurrentBatchActor } from './current-batch-actor.decorator';
