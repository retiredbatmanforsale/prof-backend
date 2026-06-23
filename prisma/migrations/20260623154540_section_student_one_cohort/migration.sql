-- ONE-COHORT hard guarantee: a member belongs to exactly one organization, so a
-- global unique on organizationMemberId guarantees a member appears in at most
-- one section — backstopping the app-level check against TOCTOU races.

-- DropIndex
DROP INDEX "section_students_organizationMemberId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "section_students_organizationMemberId_key" ON "section_students"("organizationMemberId");
