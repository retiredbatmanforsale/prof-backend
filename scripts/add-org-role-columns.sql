-- Surgical, ADDITIVE migration — adds the OrgRole enum + orgRole columns.
-- NON-DESTRUCTIVE: drops nothing, rewrites nothing (ADD COLUMN with a constant
-- default is metadata-only on PG11+). Safe to run against a prod-drifted DB
-- where `prisma db push` would be dangerous.
-- Idempotent: re-running is a no-op.

-- 1. The enum type (CREATE TYPE has no IF NOT EXISTS, so guard it).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrgRole') THEN
    CREATE TYPE "OrgRole" AS ENUM ('STUDENT', 'CAMPUS_ADMIN', 'FACULTY', 'LAB_ASSISTANT', 'TA');
  END IF;
END$$;

-- 2. The columns, defaulting to STUDENT so existing rows are valid immediately.
ALTER TABLE "organization_members"
  ADD COLUMN IF NOT EXISTS "orgRole" "OrgRole" NOT NULL DEFAULT 'STUDENT';

ALTER TABLE "preloaded_students"
  ADD COLUMN IF NOT EXISTS "orgRole" "OrgRole" NOT NULL DEFAULT 'STUDENT';
