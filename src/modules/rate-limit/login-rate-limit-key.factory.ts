import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';

export const LOGIN_RATE_LIMIT_NAMESPACE =
  'smartlearning:login-rate-limit:v1:{login}';

@Injectable()
export class LoginRateLimitKeyFactory {
  readonly namespace: string;
  private readonly secret: string;

  constructor(secret: string, namespace = LOGIN_RATE_LIMIT_NAMESPACE) {
    this.secret = secret;
    this.namespace = namespace;
  }

  account(identifier: string): string {
    const normalizedIdentifier = identifier
      .normalize('NFKC')
      .trim()
      .toLowerCase();
    return `${this.namespace}:account:${this.digest('account\0', normalizedIdentifier)}`;
  }

  source(source: string): string {
    return `${this.namespace}:source:${this.digest('source\0', source)}`;
  }

  private digest(domain: string, value: string): string {
    return createHmac('sha256', this.secret)
      .update(domain, 'utf8')
      .update(value, 'utf8')
      .digest('hex');
  }
}
