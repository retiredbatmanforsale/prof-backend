// PHASE B — legacy-org backfill. Migrates old "flat" universities into the new
// cohort + flat-role model. Idempotent; dry-run by default.
//
// Three normalizations (all safe to re-run):
//   1. STAFF ROLE FLATTENING: every non-student staff member (CAMPUS_ADMIN /
//      LAB_ASSISTANT / TA, or legacy isOrgAdmin) → orgRole=FACULTY, isOrgAdmin
//      cleared. Students are untouched.
//   2. DEFAULT COHORT: every org that has un-cohorted students (or no sections)
//      gets a Section named "Default Cohort" (upsert on the (organizationId,
//      name) unique — never duplicates).
//   3. ATTACH STUDENTS: every active orgRole=STUDENT member with no
//      SectionStudent row is attached to its org's Default Cohort.
//      createMany({skipDuplicates}) + the one-cohort unique make this a no-op on
//      re-run and race-safe.
//
// Run order note: do step 1 (role flatten) BEFORE counting students, so a
// mis-roled legacy "student" that is really staff isn't cohorted. Members are
// classified by orgRole AFTER flattening.
//
// Usage:
//   node prisma/prod-deploy/backfill_legacy_orgs.mjs            # DRY-RUN (default)
//   node prisma/prod-deploy/backfill_legacy_orgs.mjs --apply    # perform writes
//
// Drive from the RUNBOOK (clone dry-run first, then --apply in the window).

import { PrismaClient, OrgRole } from "@prisma/client";

const APPLY = process.argv.includes("--apply");
const DEFAULT_COHORT_NAME = "Default Cohort";
const prisma = new PrismaClient();

async function main() {
  // ── 1. Staff role flattening ──────────────────────────────────────────────
  const staffToFlatten = await prisma.organizationMember.findMany({
    where: {
      OR: [
        { isOrgAdmin: true },
        { orgRole: { in: [OrgRole.CAMPUS_ADMIN, OrgRole.LAB_ASSISTANT, OrgRole.TA] } },
      ],
    },
    select: { id: true, orgRole: true, isOrgAdmin: true },
  });

  // ── 2/3. Cohort backfill targets ──────────────────────────────────────────
  const orgsNoSection = await prisma.organization.findMany({
    where: { sections: { none: {} } },
    select: { id: true },
  });
  const orphanStudents = await prisma.organizationMember.findMany({
    where: { orgRole: OrgRole.STUDENT, isActive: true, sectionStudentOf: { none: {} } },
    select: { id: true, organizationId: true },
  });

  console.log(`[backfill] mode = ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`[backfill] staff to flatten -> FACULTY   : ${staffToFlatten.length}`);
  console.log(`[backfill] orgs with no sections          : ${orgsNoSection.length}`);
  console.log(`[backfill] un-cohorted STUDENT members    : ${orphanStudents.length}`);

  if (!APPLY) {
    console.log("[backfill] dry-run only — re-run with --apply to write. No changes made.");
    return;
  }

  // 1. Flatten staff roles.
  let flattened = 0;
  for (const m of staffToFlatten) {
    await prisma.organizationMember.update({
      where: { id: m.id },
      data: { orgRole: OrgRole.FACULTY, isOrgAdmin: false },
    });
    flattened++;
  }

  // 2. Ensure a Default Cohort for every org that needs one.
  const orgIdsNeedingCohort = new Set([
    ...orgsNoSection.map((o) => o.id),
    ...orphanStudents.map((s) => s.organizationId),
  ]);
  const cohortByOrg = new Map();
  for (const organizationId of orgIdsNeedingCohort) {
    const section = await prisma.section.upsert({
      where: { organizationId_name: { organizationId, name: DEFAULT_COHORT_NAME } },
      update: {},
      create: { organizationId, name: DEFAULT_COHORT_NAME, createdViaCsv: false },
      select: { id: true },
    });
    cohortByOrg.set(organizationId, section.id);
  }

  // 3. Attach orphan students.
  let attached = 0;
  for (const s of orphanStudents) {
    const sectionId = cohortByOrg.get(s.organizationId);
    if (!sectionId) continue;
    const res = await prisma.sectionStudent.createMany({
      data: [{ sectionId, organizationMemberId: s.id }],
      skipDuplicates: true,
    });
    attached += res.count;
  }

  console.log(`[backfill] staff flattened to FACULTY     : ${flattened}`);
  console.log(`[backfill] default cohorts ensured        : ${cohortByOrg.size}`);
  console.log(`[backfill] students attached              : ${attached}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("[backfill] FAILED:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
