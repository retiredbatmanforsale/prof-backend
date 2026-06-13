-- Surgical, ADDITIVE migration — adds PreloadedStudent.sectionId so a roster
-- CSV can record a student's intended section before they have an account.
-- NON-DESTRUCTIVE (ADD COLUMN, nullable) + an FK with ON DELETE SET NULL.
-- Idempotent.

ALTER TABLE "preloaded_students"
  ADD COLUMN IF NOT EXISTS "sectionId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preloaded_students_sectionId_fkey') THEN
    ALTER TABLE "preloaded_students" ADD CONSTRAINT "preloaded_students_sectionId_fkey"
      FOREIGN KEY ("sectionId") REFERENCES "sections" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;
