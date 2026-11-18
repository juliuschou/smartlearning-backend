import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuthConfig } from './auth.config';

@Injectable()
export class OriginPolicyService {
  constructor(private readonly config: AuthConfig) {}

  // 僅接受清單內完全相同的來源，不用部分字串比對，以免相似網址混入。
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
