-- Surgical, ADDITIVE migration — creates the 3 section tables.
-- NON-DESTRUCTIVE: only CREATE TABLE / CREATE INDEX, touches no existing table.
-- Safe against a prod-drifted DB where `prisma db push` would be dangerous.
-- Idempotent: re-running is a no-op (IF NOT EXISTS throughout).

CREATE TABLE IF NOT EXISTS "sections" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "course"         TEXT,
  "createdViaCsv"  BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "section_students" (
  "id"                   TEXT NOT NULL,
  "sectionId"            TEXT NOT NULL,
  "organizationMemberId" TEXT NOT NULL,
  CONSTRAINT "section_students_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "section_assignments" (
  "id"                   TEXT NOT NULL,
  "sectionId"            TEXT NOT NULL,
  "organizationMemberId" TEXT NOT NULL,
  "assignedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assignedByUserId"     TEXT,
  CONSTRAINT "section_assignments_pkey" PRIMARY KEY ("id")
);

-- Indexes + unique constraints (match schema.prisma).
CREATE INDEX IF NOT EXISTS "sections_organizationId_idx" ON "sections" ("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "sections_organizationId_name_key" ON "sections" ("organizationId", "name");

CREATE INDEX IF NOT EXISTS "section_students_organizationMemberId_idx" ON "section_students" ("organizationMemberId");
CREATE UNIQUE INDEX IF NOT EXISTS "section_students_sectionId_organizationMemberId_key" ON "section_students" ("sectionId", "organizationMemberId");

CREATE INDEX IF NOT EXISTS "section_assignments_organizationMemberId_idx" ON "section_assignments" ("organizationMemberId");
CREATE UNIQUE INDEX IF NOT EXISTS "section_assignments_sectionId_organizationMemberId_key" ON "section_assignments" ("sectionId", "organizationMemberId");

-- Foreign keys (ON DELETE CASCADE, matching the Prisma relations).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sections_organizationId_fkey') THEN
    ALTER TABLE "sections" ADD CONSTRAINT "sections_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'section_students_sectionId_fkey') THEN
    ALTER TABLE "section_students" ADD CONSTRAINT "section_students_sectionId_fkey"
      FOREIGN KEY ("sectionId") REFERENCES "sections" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'section_students_organizationMemberId_fkey') THEN
    ALTER TABLE "section_students" ADD CONSTRAINT "section_students_organizationMemberId_fkey"
      FOREIGN KEY ("organizationMemberId") REFERENCES "organization_members" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'section_assignments_sectionId_fkey') THEN
    ALTER TABLE "section_assignments" ADD CONSTRAINT "section_assignments_sectionId_fkey"
      FOREIGN KEY ("sectionId") REFERENCES "sections" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'section_assignments_organizationMemberId_fkey') THEN
    ALTER TABLE "section_assignments" ADD CONSTRAINT "section_assignments_organizationMemberId_fkey"
      FOREIGN KEY ("organizationMemberId") REFERENCES "organization_members" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;
