-- Surgical, ADDITIVE migration — creates the assessment_attempts table.
-- NON-DESTRUCTIVE: one new enum + one new table + indexes + FKs. Touches no
-- existing table. Idempotent (guarded enum, CREATE TABLE/INDEX IF NOT EXISTS,
-- pg_constraint-guarded FKs). Depends on add-assessments.sql and the `users`
-- table (both confirmed present).
--
-- Keyed by userId (NOT organizationMemberId) so independent PROF_GLOBAL
-- students — who have no org membership — can attempt assessments.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AttemptStatus') THEN
    CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'EXITED', 'SUBMITTED', 'LOCKED');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "assessment_attempts" (
  "id"                TEXT NOT NULL,
  "assessmentId"      TEXT NOT NULL,
  "userId"            TEXT NOT NULL,
  "startedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "exitedAt"          TIMESTAMP(3),
  "remainingAttempts" INTEGER NOT NULL DEFAULT 1,
  "status"            "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "answers"           JSONB,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "assessment_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "assessment_attempts_assessmentId_userId_key"
  ON "assessment_attempts" ("assessmentId", "userId");
CREATE INDEX IF NOT EXISTS "assessment_attempts_userId_idx"
  ON "assessment_attempts" ("userId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessment_attempts_assessmentId_fkey') THEN
    ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_assessmentId_fkey"
      FOREIGN KEY ("assessmentId") REFERENCES "assessments" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessment_attempts_userId_fkey') THEN
    ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
