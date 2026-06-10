-- Backfill orgRole from the legacy isOrgAdmin boolean.
-- Run ONCE, right after `npm run db:push` adds the orgRole columns.
-- Safe to re-run (idempotent): only touches rows still left at STUDENT.
-- Faculty/Lab/TA tiers are NOT inferable from isOrgAdmin and are assigned
-- separately (via the staff CSV upload / admin UI), so they are untouched here.

UPDATE organization_members
SET "orgRole" = 'CAMPUS_ADMIN'
WHERE "isOrgAdmin" = true
  AND "orgRole" = 'STUDENT';

UPDATE preloaded_students
SET "orgRole" = 'CAMPUS_ADMIN'
WHERE "isOrgAdmin" = true
  AND "orgRole" = 'STUDENT';
