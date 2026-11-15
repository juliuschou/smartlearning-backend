import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuthConfig } from './auth.config';

@Injectable()
export class OriginPolicyService {
  constructor(private readonly config: AuthConfig) {}

  isAllowed(origin: string | undefined): boolean {
    return Boolean(origin && this.config.allowedOrigins.has(origin));
  }

  assertAllowed(origin: string | undefined): void {
    if (!this.isAllowed(origin)) {
      throw new ForbiddenException({
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Request origin is not allowed.',
      });
    }
  }
}
