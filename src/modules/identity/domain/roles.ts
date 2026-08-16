/**
 * Account roles (M2 關鍵技術決策 §2: TEXT + CHECK, app-layer union guard).
 * MVP creates only `admin` and `teacher` Web accounts — no student accounts.
 */
export const AccountRole = {
  ADMIN: 'admin',
  TEACHER: 'teacher',
} as const;

export type AccountRole = (typeof AccountRole)[keyof typeof AccountRole];

export const ACCOUNT_ROLES: readonly AccountRole[] = [
  AccountRole.ADMIN,
  AccountRole.TEACHER,
];

export function isAccountRole(value: string): value is AccountRole {
  return (ACCOUNT_ROLES as readonly string[]).includes(value);
}
