-- Phase B2: persistent Course roster for authenticated students.
-- Keep removed rows so a later add can reactivate the same membership.

CREATE TABLE "course_enrollment" (
    "id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "student_account_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "enrolled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "course_enrollment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "course_enrollment_status_check"
      CHECK ("status" IN ('active', 'removed')),
    CONSTRAINT "course_enrollment_course_id_fkey"
      FOREIGN KEY ("course_id") REFERENCES "course"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "course_enrollment_student_account_id_fkey"
      FOREIGN KEY ("student_account_id") REFERENCES "account"("id")
      ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "uq_course_enrollment_course_student"
  ON "course_enrollment"("course_id", "student_account_id");
CREATE INDEX "idx_course_enrollment_course_status"
  ON "course_enrollment"("course_id", "status");
CREATE INDEX "idx_course_enrollment_student_status"
  ON "course_enrollment"("student_account_id", "status");
