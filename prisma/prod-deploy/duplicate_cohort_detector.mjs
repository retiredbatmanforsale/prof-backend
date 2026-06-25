// Pre-flight for the ONE-COHORT unique (section_students.organizationMemberId).
// The CREATE UNIQUE INDEX in the prod delta will FAIL if any member is already
// in more than one cohort. This finds and PRINTS those rows. It NEVER deletes
// or mutates anything — a human decides which membership to keep.
//
// Exit code: 0 = clean (safe to apply the unique), 1 = duplicates found (stop).
//
// Usage:
//   DATABASE_URL=<prod-or-clone-url> node prisma/prod-deploy/duplicate_cohort_detector.mjs

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const dupes = await prisma.$queryRawUnsafe(
    `SELECT ss."organizationMemberId",
            om."userId",
            u.email,
            COUNT(*)::int AS cohort_count,
            array_agg(sec.name ORDER BY sec.name) AS cohorts
       FROM section_students ss
       JOIN organization_members om ON om.id = ss."organizationMemberId"
       JOIN users u ON u.id = om."userId"
       JOIN sections sec ON sec.id = ss."sectionId"
      GROUP BY ss."organizationMemberId", om."userId", u.email
     HAVING COUNT(*) > 1
      ORDER BY cohort_count DESC`
  );

  const total = await prisma.sectionStudent.count();
  console.log(`[detector] total section_students rows : ${total}`);
  console.log(`[detector] members in >1 cohort         : ${dupes.length}`);

  if (dupes.length === 0) {
    console.log("[detector] CLEAN — safe to apply the one-student-one-cohort unique.");
    return 0;
  }

  console.log("\n[detector] DUPLICATES (resolve by hand before applying the unique):");
  for (const d of dupes) {
    console.log(
      `  member=${d.organizationMemberId} user=${d.email} ` +
        `count=${d.cohort_count} cohorts=[${d.cohorts.join(", ")}]`
    );
  }
  console.log(
    "\n[detector] STOP. Pick the cohort to keep for each member and delete the " +
      "other section_students row(s) MANUALLY, then re-run. No auto-delete."
  );
  return 1;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error("[detector] FAILED:", e.message);
    await prisma.$disconnect();
    process.exit(2);
  });
