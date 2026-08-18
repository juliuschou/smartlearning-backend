-- Phase B1: add authenticated student accounts.
-- Keep role/state values as TEXT + CHECK per the M2 decision.

ALTER TABLE "account"
  DROP CONSTRAINT "account_role_check",
  ADD CONSTRAINT "account_role_check"
    CHECK ("role" IN ('admin', 'teacher', 'student')),
  ADD CONSTRAINT "account_student_can_create_course_check"
    CHECK ("role" <> 'student' OR "can_create_course" = false);
