/**
 * Course enrollment status (TEXT + CHECK). Removed rows remain for
 * reactivation and are not exposed as historical records in this phase.
 */
export const EnrollmentStatus = {
  ACTIVE: 'active',
  REMOVED: 'removed',
} as const;

export type EnrollmentStatus =
  (typeof EnrollmentStatus)[keyof typeof EnrollmentStatus];

export const ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = [
  EnrollmentStatus.ACTIVE,
  EnrollmentStatus.REMOVED,
];

export function isEnrollmentStatus(value: string): value is EnrollmentStatus {
  return (ENROLLMENT_STATUSES as readonly string[]).includes(value);
}
