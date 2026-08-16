import type { Account } from '../../../generated/prisma/client';

/**
 * Authenticated principal attached to the request by SessionGuard.
 * Only the fields a handler needs to authorize — never the password hash.
 */
export interface AuthContext {
  account: Pick<
    Account,
    | 'id'
    | 'username'
    | 'displayName'
    | 'role'
    | 'status'
    | 'canCreateCourse'
    | 'mustChangePassword'
  >;
  sessionId: string;
}
