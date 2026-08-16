/**
 * Course status (TEXT + CHECK). draft → archived is terminal.
 * Owner is immutable; archived courses are read-only (no question writes —
 * questions are a later phase, but the guard is modeled here).
 */
export const CourseStatus = {
  DRAFT: 'draft',
  ARCHIVED: 'archived',
} as const;

export type CourseStatus = (typeof CourseStatus)[keyof typeof CourseStatus];

export const COURSE_STATUSES: readonly CourseStatus[] = [
  CourseStatus.DRAFT,
  CourseStatus.ARCHIVED,
];

export function isCourseStatus(value: string): value is CourseStatus {
  return (COURSE_STATUSES as readonly string[]).includes(value);
}

/** Transition guard: only draft → archived is allowed; archived is terminal. */
export function canArchive(current: CourseStatus): boolean {
  return current === CourseStatus.DRAFT;
}

export function canMutate(current: CourseStatus): boolean {
  return current === CourseStatus.DRAFT;
}
