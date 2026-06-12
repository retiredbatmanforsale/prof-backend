-- Surgical, ADDITIVE migration — adds authoring metadata + in-test rules to
-- `assessments`. NON-DESTRUCTIVE: 3 new enum types + 6 defaulted columns on a
-- table we own. No ALTER of existing columns, no drops. Idempotent (guarded
-- enums + ADD COLUMN IF NOT EXISTS). Depends on add-assessments.sql.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssessmentTrack') THEN
    CREATE TYPE "AssessmentTrack" AS ENUM ('DSA', 'AIML', 'MIXED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AttemptPolicy') THEN
    CREATE TYPE "AttemptPolicy" AS ENUM ('UNLIMITED', 'SINGLE', 'NONE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NavigationMode') THEN
    CREATE TYPE "NavigationMode" AS ENUM ('FREE', 'SEQUENTIAL');
  END IF;
END$$;

ALTER TABLE "assessments"
  ADD COLUMN IF NOT EXISTS "track"            "AssessmentTrack" NOT NULL DEFAULT 'MIXED',
  ADD COLUMN IF NOT EXISTS "attemptPolicy"    "AttemptPolicy"   NOT NULL DEFAULT 'UNLIMITED',
  ADD COLUMN IF NOT EXISTS "lateEntryAllowed" BOOLEAN           NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "shuffleQuestions" BOOLEAN           NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "navigationMode"   "NavigationMode"  NOT NULL DEFAULT 'FREE',
  ADD COLUMN IF NOT EXISTS "autoSubmit"       BOOLEAN           NOT NULL DEFAULT true;
