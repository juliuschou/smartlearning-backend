import {
  CourseStatus,
  canArchive,
  canMutate,
  isCourseStatus,
} from './course-status';

describe('course-status', () => {
  it('allows archive only from draft', () => {
    expect(canArchive(CourseStatus.DRAFT)).toBe(true);
    expect(canArchive(CourseStatus.ARCHIVED)).toBe(false);
  });

  it('archived is terminal and read-only', () => {
    expect(canMutate(CourseStatus.DRAFT)).toBe(true);
    expect(canMutate(CourseStatus.ARCHIVED)).toBe(false);
  });

  it('isCourseStatus recognizes valid status strings', () => {
    expect(isCourseStatus('draft')).toBe(true);
    expect(isCourseStatus('archived')).toBe(true);
    expect(isCourseStatus('live')).toBe(false);
    expect(isCourseStatus('')).toBe(false);
  });
});
