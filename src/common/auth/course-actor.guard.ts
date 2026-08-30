import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenError } from '../errors';
import { CliCredentialScope } from '../../modules/identity/domain/cli-credential-status';
import {
  CliAuthGuard,
  CLI_KEY_HEADER,
} from '../../modules/identity/api/cli-auth.guard';
import { CLI_AUTH_CONTEXT_KEY, type CliAuthContext } from './cli-auth-context';
import { SessionGuard } from './session.guard';
import type { AuthContext } from './auth-context';

export interface CourseActorContext {
  kind: 'web' | 'cli';
  accountId: string;
  role: string;
  cliCredentialId?: string;
  cliScope?: string;
}

export const COURSE_ACTOR_KEY = 'courseActor';

declare module 'express' {
  interface Request {
    courseActor?: CourseActorContext;
  }
}

/** Authenticate Course collection routes through either Web session or CLI key. */
@Injectable()
export class CourseActorGuard implements CanActivate {
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

    if (cliKey !== undefined) {
      await this.cliAuth.canActivate(context);
      const cli = request[CLI_AUTH_CONTEXT_KEY];
      if (!cli) return false;
      this.assertTeacherOrAdmin(cli.account.role);
      if (cli.scope !== CliCredentialScope.ALL_COURSES) {
        throw new ForbiddenError('CLI credential scope is not supported');
      }
      request[COURSE_ACTOR_KEY] = {
        kind: 'cli',
        accountId: cli.account.id,
        role: cli.account.role,
        cliCredentialId: cli.credentialId,
        cliScope: cli.scope,
      };
      return true;
    }

    await this.sessions.canActivate(context);
    const auth = request.authContext;
    if (!auth) return false;
    this.assertTeacherOrAdmin(auth.account.role);
    request[COURSE_ACTOR_KEY] = {
      kind: 'web',
      accountId: auth.account.id,
      role: auth.account.role,
    };
    return true;
  }

  private assertTeacherOrAdmin(role: string): void {
    if (role !== 'teacher' && role !== 'admin') {
      throw new ForbiddenError('Teacher or admin role required');
    }
  }
}
