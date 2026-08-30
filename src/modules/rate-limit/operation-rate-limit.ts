import { SetMetadata } from '@nestjs/common';

export enum OperationRateLimitPolicy {
  CLI_COURSES_LIST = 'cli:courses:list',
  CLI_COURSES_CREATE = 'cli:courses:create',
  CLI_BATCH_VALIDATE = 'cli:question-batches:validate',
  CLI_BATCH_CONFIRM = 'cli:question-batches:confirm',
}

export const OPERATION_RATE_LIMIT_POLICY_KEY = 'operationRateLimitPolicy';

export const OperationRateLimit = (policy: OperationRateLimitPolicy) =>
  SetMetadata(OPERATION_RATE_LIMIT_POLICY_KEY, policy);
