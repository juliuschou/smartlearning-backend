export const CliCredentialStatus = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
} as const;

export type CliCredentialStatus =
  (typeof CliCredentialStatus)[keyof typeof CliCredentialStatus];

export const CLI_CREDENTIAL_STATUSES: readonly CliCredentialStatus[] = [
  CliCredentialStatus.ACTIVE,
  CliCredentialStatus.REVOKED,
];

export function isCliCredentialStatus(
  value: string,
): value is CliCredentialStatus {
  return (CLI_CREDENTIAL_STATUSES as readonly string[]).includes(value);
}

export const CliCredentialScope = {
  ALL_COURSES: 'all_courses',
  SINGLE_COURSE: 'single_course',
} as const;

export type CliCredentialScope =
  (typeof CliCredentialScope)[keyof typeof CliCredentialScope];
