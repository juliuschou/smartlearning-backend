/**
 * Account response projection — never includes password_hash.
 * Wire contract: UUID id, UTC timestamps, stable field names.
 */
export class AccountDto {
  id!: string;
  username!: string;
  displayName!: string;
  role!: string;
  status!: string;
  canCreateCourse!: boolean;
  mustChangePassword!: boolean;
  disabledAt!: string | null;
  createdAt!: string;
}

export class SessionDto {
  accountId!: string;
  username!: string;
  displayName!: string;
  role!: string;
  canCreateCourse!: boolean;
  mustChangePassword!: boolean;
  sessionId!: string;
  expiresAt!: string;
}
