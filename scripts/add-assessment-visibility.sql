-- Surgical, ADDITIVE migration — adds assessment visibility tier (PROF_GLOBAL /
-- ORGANIZATION / SECTION). NON-DESTRUCTIVE: creates one enum type and adds one
-- defaulted column to `assessments`. Touches no other table, drops nothing.
-- Idempotent: guarded enum + ADD COLUMN IF NOT EXISTS.
--
-- Depends on scripts/add-assessments.sql already being applied.
--
-- Visibility ↔ authoring role:
--   PROF_GLOBAL  → Root Admin   → independent users (no org membership)
--   ORGANIZATION → Campus Admin → all students in the org
--   SECTION      → Faculty/TA   → students in the assigned section(s)  [default]

-- Enum (Postgres has no CREATE TYPE IF NOT EXISTS — guard on pg_type).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssessmentVisibility') THEN
    CREATE TYPE "AssessmentVisibility" AS ENUM ('PROF_GLOBAL', 'ORGANIZATION', 'SECTION');
  END IF;
END$$;

-- Additive column. Existing rows backfill to 'SECTION' via the default, which
-- matches today's reality (every existing assessment is faculty/section-scoped).
ALTER TABLE "assessments"
  ADD COLUMN IF NOT EXISTS "visibility" "AssessmentVisibility" NOT NULL DEFAULT 'SECTION';
