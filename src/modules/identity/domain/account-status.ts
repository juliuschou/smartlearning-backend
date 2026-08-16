/**
 * Account status (TEXT + CHECK). active ⇄ disabled.
 * disabled accounts cannot log in and all sessions/CLI credentials become
 * invalid (P0-03). Account transitions are transactionally enforced by the
 * identity application service.
 */
export const AccountStatus = {
  ACTIVE: 'active',
  DISABLED: 'disabled',
} as const;

export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const ACCOUNT_STATUSES: readonly AccountStatus[] = [
  AccountStatus.ACTIVE,
  AccountStatus.DISABLED,
];

export function isAccountStatus(value: string): value is AccountStatus {
  return (ACCOUNT_STATUSES as readonly string[]).includes(value);
}
