/**
 * Account roles (M2 關鍵技術決策 §2: TEXT + CHECK, app-layer union guard).
 */
export const AccountRole = {
  ADMIN: 'admin',
  TEACHER: 'teacher',
  STUDENT: 'student',
} as const;

export type AccountRole = (typeof AccountRole)[keyof typeof AccountRole];

export const ACCOUNT_ROLES: readonly AccountRole[] = [
  AccountRole.ADMIN,
  AccountRole.TEACHER,
  AccountRole.STUDENT,
];

export function isAccountRole(value: string): value is AccountRole {
  return (ACCOUNT_ROLES as readonly string[]).includes(value);
}

export function isTeacherOrAdmin(value: string): boolean {
  return value === AccountRole.ADMIN || value === AccountRole.TEACHER;
}
