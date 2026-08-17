import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CliCredentialService } from '../application/cli-credential.service';
import { CLI_AUTH_CONTEXT_KEY } from '../../../common/auth/cli-auth-context';

export const CLI_KEY_HEADER = 'x-cli-key';

/**
 * Authenticate a CLI actor via the `X-CLI-Key` header. On success attaches
 * `req.cliAuthContext`. CLI requests are NOT cookie-authenticated and do NOT
 * require CSRF (the trust boundary is the credential header, not a browser
 * session). Fail-closed: missing/invalid/revoked key → 401.
 */
@Injectable()
export class CliAuthGuard implements CanActivate {
  constructor(private readonly cliCredentials: CliCredentialService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const rawKey = request.headers[CLI_KEY_HEADER] as string | undefined;
    // authenticate throws a DomainError (401) on missing/invalid/revoked;
    // letting it propagate lets the global exception filter map the status.
    const ctx = await this.cliCredentials.authenticate(rawKey);
    request[CLI_AUTH_CONTEXT_KEY] = ctx;
    return true;
  }
}
