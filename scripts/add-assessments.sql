-- Surgical, ADDITIVE migration — creates the assessment engine tables.
-- NON-DESTRUCTIVE: only CREATE TYPE / CREATE TABLE / CREATE INDEX; touches no
-- existing table. Safe against a prod-drifted DB where `prisma db push` would
-- be dangerous. Idempotent: re-running is a no-op (guards throughout).
--
-- Depends on the section tables (scripts/add-sections.sql) and the OrgRole
-- columns (scripts/add-org-role-columns.sql) already being applied.

-- Enums (Postgres has no CREATE TYPE IF NOT EXISTS — guard on pg_type).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssessmentStatus') THEN
    CREATE TYPE "AssessmentStatus" AS ENUM ('DRAFT', 'PUBLISHED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QuestionKind') THEN
    CREATE TYPE "QuestionKind" AS ENUM ('CATALOG', 'CUSTOM');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "assessments" (
  "id"                TEXT NOT NULL,
  "organizationId"    TEXT NOT NULL,
  "createdByMemberId" TEXT NOT NULL,
  "title"             TEXT NOT NULL,
  "description"       TEXT,
  "status"            "AssessmentStatus" NOT NULL DEFAULT 'DRAFT',
  "durationMinutes"   INTEGER,
  "opensAt"           TIMESTAMP(3),
  "dueAt"             TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "assessments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "assessment_questions" (
  "id"           TEXT NOT NULL,
  "assessmentId" TEXT NOT NULL,
  "order"        INTEGER NOT NULL,
  "kind"         "QuestionKind" NOT NULL,
  "points"       INTEGER,
  "catalogSlug"  TEXT,
  "title"        TEXT,
  "content"      JSONB,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "assessment_questions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "assessment_assignments" (
  "id"                 TEXT NOT NULL,
  "assessmentId"       TEXT NOT NULL,
  "sectionId"          TEXT NOT NULL,
  "assignedByMemberId" TEXT,
  "assignedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assessment_assignments_pkey" PRIMARY KEY ("id")
);

-- Indexes + unique constraints (match schema.prisma).
CREATE INDEX IF NOT EXISTS "assessments_organizationId_idx" ON "assessments" ("organizationId");
CREATE INDEX IF NOT EXISTS "assessments_createdByMemberId_idx" ON "assessments" ("createdByMemberId");

CREATE INDEX IF NOT EXISTS "assessment_questions_assessmentId_idx" ON "assessment_questions" ("assessmentId");

CREATE INDEX IF NOT EXISTS "assessment_assignments_sectionId_idx" ON "assessment_assignments" ("sectionId");
CREATE UNIQUE INDEX IF NOT EXISTS "assessment_assignments_assessmentId_sectionId_key" ON "assessment_assignments" ("assessmentId", "sectionId");

-- Foreign keys (matching the Prisma relations).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessments_organizationId_fkey') THEN
    ALTER TABLE "assessments" ADD CONSTRAINT "assessments_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  -- Author relation has no onDelete in schema → Prisma default RESTRICT.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessments_createdByMemberId_fkey') THEN
    ALTER TABLE "assessments" ADD CONSTRAINT "assessments_createdByMemberId_fkey"
      FOREIGN KEY ("createdByMemberId") REFERENCES "organization_members" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessment_questions_assessmentId_fkey') THEN
    ALTER TABLE "assessment_questions" ADD CONSTRAINT "assessment_questions_assessmentId_fkey"
      FOREIGN KEY ("assessmentId") REFERENCES "assessments" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessment_assignments_assessmentId_fkey') THEN
    ALTER TABLE "assessment_assignments" ADD CONSTRAINT "assessment_assignments_assessmentId_fkey"
      FOREIGN KEY ("assessmentId") REFERENCES "assessments" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessment_assignments_sectionId_fkey') THEN
    ALTER TABLE "assessment_assignments" ADD CONSTRAINT "assessment_assignments_sectionId_fkey"
      FOREIGN KEY ("sectionId") REFERENCES "sections" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
