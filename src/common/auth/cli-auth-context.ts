import type { CliAuthContext } from '../../modules/identity/application/cli-credential.service';

/**
 * Request property name for the CLI principal attached by CliAuthGuard.
 * Mirrors `authContext` (SessionGuard) so handlers can branch on principal
 * kind without importing guard internals.
 */
export const CLI_AUTH_CONTEXT_KEY = 'cliAuthContext';

declare module 'express' {
  interface Request {
    cliAuthContext?: CliAuthContext;
  }
}

export type { CliAuthContext };
