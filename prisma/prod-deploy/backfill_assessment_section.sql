-- ────────────────────────────────────────────────────────────────────────────
-- DATA BACKFILL: assessment_assignments  →  assessments.sectionId
-- ────────────────────────────────────────────────────────────────────────────
-- Phase 8 dropped the AssessmentAssignment join table; an assessment is now
-- owned by exactly ONE cohort via assessments."sectionId". On a fresh DB the
-- baseline never creates assessment_assignments, so there's nothing to migrate.
-- But the EXISTING production DB still has that table (and may hold rows that
-- link assessments to cohorts). If we let the auto-generated delta simply
-- DROP it, those assessment→cohort links are LOST.
--
-- This script copies the link across BEFORE the drop. Splice it into the
-- generated delta so it runs:
--    AFTER  : ALTER TABLE "assessments" ADD COLUMN "sectionId" ...
--    BEFORE : DROP TABLE "assessment_assignments" ...
--
-- It is idempotent and self-guarding: a no-op if either the table or the new
-- column is absent, and it never overwrites a sectionId that's already set.

DO $$
BEGIN
  IF to_regclass('public.assessment_assignments') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'assessments' AND column_name = 'sectionId'
     )
  THEN
    -- The old model was many-to-many (one assessment could be assigned to
    -- several cohorts). The new model is a single owning cohort, so we keep the
    -- EARLIEST assignment (by assignedAt) for each assessment.
    UPDATE "assessments" a
       SET "sectionId" = pick."sectionId"
      FROM (
        SELECT DISTINCT ON ("assessmentId") "assessmentId", "sectionId"
          FROM "assessment_assignments"
         ORDER BY "assessmentId", "assignedAt" ASC
      ) AS pick
     WHERE pick."assessmentId" = a."id"
       AND a."sectionId" IS NULL;

    RAISE NOTICE 'Backfilled assessments.sectionId from assessment_assignments (% rows).',
      (SELECT count(*) FROM "assessments" WHERE "sectionId" IS NOT NULL);
  ELSE
    RAISE NOTICE 'Skip backfill: assessment_assignments or assessments.sectionId not present.';
  END IF;
END $$;
