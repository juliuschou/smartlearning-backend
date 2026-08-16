import { SetMetadata } from '@nestjs/common';

/**
 * Marks an authenticated route that remains available while the account is
 * required to replace a temporary/reset password.
 */
export const ALLOW_PASSWORD_CHANGE_REQUIRED = 'allowPasswordChangeRequired';
export const AllowPasswordChangeRequired = () =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED, true);
