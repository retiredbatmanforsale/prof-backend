// Verify the cohort remove/move endpoints against a DISPOSABLE Neon branch.
// Seeds a clearly-tagged scratch org, drives the REAL route handlers via
// app.inject() with a signed faculty JWT, asserts DB state, then deletes every
// seeded row. Never touches real data. Run:
//   npx tsx --env-file=.env.verify scripts/verify-cohort-mgmt.ts
import { buildApp } from "../src/app.js";

const TAG = `ZZ_VERIFY_${Date.now()}`;
let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

async function main() {
  const app = await buildApp();
  const prisma = app.prisma;

  // refs for cleanup
  let orgId = "",
    facultyUserId = "",
    studentUserId = "",
    sectionAId = "",
    sectionBId = "",
    compId = "",
    studentMemberId = "";

  try {
    // ── seed ───────────────────────────────────────────────────────────────
    const org = await prisma.organization.create({
      data: {
        name: `${TAG} Org`,
        slug: `${TAG.toLowerCase()}-org`,
        emailDomains: [`${TAG.toLowerCase()}.edu`],
      },
    });
    orgId = org.id;
    const sectionA = await prisma.section.create({
      data: { organizationId: org.id, name: "Section A", course: "Verify 101" },
    });
    const sectionB = await prisma.section.create({
      data: { organizationId: org.id, name: "Section B" },
    });
    sectionAId = sectionA.id;
    sectionBId = sectionB.id;

    const facultyUser = await prisma.user.create({
      data: { name: `${TAG} Faculty`, email: `faculty.${TAG.toLowerCase()}@x.edu` },
    });
    facultyUserId = facultyUser.id;
    await prisma.organizationMember.create({
      data: { userId: facultyUser.id, organizationId: org.id, orgRole: "FACULTY", isActive: true, isVerified: true },
    });

    const studentUser = await prisma.user.create({
      data: { name: `${TAG} Student`, email: `student.${TAG.toLowerCase()}@x.edu` },
    });
    studentUserId = studentUser.id;
    const studentMember = await prisma.organizationMember.create({
      data: { userId: studentUser.id, organizationId: org.id, orgRole: "STUDENT", isActive: true, isVerified: true },
    });
    studentMemberId = studentMember.id;

    // student starts in Section A
    await prisma.sectionStudent.create({
      data: { sectionId: sectionA.id, organizationMemberId: studentMember.id },
    });

    // a grade for the student in Section A — must survive remove/move
    const comp = await prisma.gradeComponent.create({
      data: { sectionId: sectionA.id, name: "Quiz 1", type: "QUIZ", maxMarks: 100, weight: 20 },
    });
    compId = comp.id;
    await prisma.gradeEntry.create({
      data: { componentId: comp.id, studentId: studentUser.id, score: 88, source: "MANUAL" },
    });

    // faculty JWT — signed by the app; requireFaculty re-checks membership in DB
    const token = app.jwt.sign({
      userId: facultyUser.id,
      email: facultyUser.email,
      role: "USER",
      hasAccess: true,
      accessType: "institution",
      organizationName: org.name,
      organizationId: org.id,
      isOrgAdmin: false,
      orgRole: "FACULTY",
    });
    const headers = { authorization: `Bearer ${token}` };

    const countIn = (sectionId: string) => prisma.sectionStudent.count({ where: { sectionId } });
    const cohortsOf = () =>
      prisma.sectionStudent.findMany({ where: { organizationMemberId: studentMember.id }, select: { sectionId: true } });
    const gradeKept = async () =>
      (await prisma.gradeEntry.count({ where: { componentId: comp.id, studentId: studentUser.id } })) === 1;

    console.log(`\nSeeded scratch cohort (${TAG}). Driving real /faculty endpoints:\n`);

    // ── 1. MOVE  A → B ──────────────────────────────────────────────────────
    const move = await app.inject({
      method: "POST",
      url: `/faculty/sections/${sectionA.id}/students/${studentUser.id}/move`,
      headers,
      payload: { toSectionId: sectionB.id },
    });
    ok(move.statusCode === 200, `move A→B returns 200 (got ${move.statusCode})`);
    ok((await countIn(sectionA.id)) === 0, "after move: Section A has 0 students (count updated)");
    ok((await countIn(sectionB.id)) === 1, "after move: Section B has 1 student");
    const after = await cohortsOf();
    ok(after.length === 1 && after[0].sectionId === sectionB.id, "after move: student in EXACTLY ONE cohort (B)");
    ok(await gradeKept(), "after move: grade entry survived");

    // ── 2. MOVE to same cohort → 400 ────────────────────────────────────────
    const same = await app.inject({
      method: "POST",
      url: `/faculty/sections/${sectionB.id}/students/${studentUser.id}/move`,
      headers,
      payload: { toSectionId: sectionB.id },
    });
    ok(same.statusCode === 400, `move to same cohort rejected 400 (got ${same.statusCode})`);

    // ── 3. REMOVE from B ────────────────────────────────────────────────────
    const rm = await app.inject({
      method: "DELETE",
      url: `/faculty/sections/${sectionB.id}/students/${studentUser.id}`,
      headers,
    });
    ok(rm.statusCode === 200, `remove returns 200 (got ${rm.statusCode})`);
    ok((await countIn(sectionB.id)) === 0, "after remove: Section B has 0 students (count updated)");
    ok((await cohortsOf()).length === 0, "after remove: student in NO cohort");
    ok(await gradeKept(), "after remove: grade entry KEPT (not destroyed)");
    ok((await prisma.user.count({ where: { id: studentUser.id } })) === 1, "after remove: student account untouched");
    ok(
      (await prisma.organizationMember.count({ where: { id: studentMember.id, isActive: true } })) === 1,
      "after remove: org membership untouched"
    );

    // ── 4. REMOVE when no longer in cohort → 404 ────────────────────────────
    const rm404 = await app.inject({
      method: "DELETE",
      url: `/faculty/sections/${sectionB.id}/students/${studentUser.id}`,
      headers,
    });
    ok(rm404.statusCode === 404, `remove when not in cohort → 404 (got ${rm404.statusCode})`);

    // ── 5. unauthenticated request → 401 ────────────────────────────────────
    const noAuth = await app.inject({
      method: "DELETE",
      url: `/faculty/sections/${sectionA.id}/students/${studentUser.id}`,
    });
    ok(noAuth.statusCode === 401, `no token → 401 (got ${noAuth.statusCode})`);
  } finally {
    // ── cleanup (best-effort; the branch also auto-deletes in ~1 day) ───────
    const safe = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* ignore */
      }
    };
    if (facultyUserId) await safe(() => prisma.adminAuditLog.deleteMany({ where: { actorId: facultyUserId } }));
    if (compId) await safe(() => prisma.gradeEntry.deleteMany({ where: { componentId: compId } }));
    if (compId) await safe(() => prisma.gradeComponent.deleteMany({ where: { id: compId } }));
    if (studentMemberId) await safe(() => prisma.sectionStudent.deleteMany({ where: { organizationMemberId: studentMemberId } }));
    if (orgId) await safe(() => prisma.organizationMember.deleteMany({ where: { organizationId: orgId } }));
    if (orgId) await safe(() => prisma.section.deleteMany({ where: { organizationId: orgId } }));
    const userIds = [facultyUserId, studentUserId].filter(Boolean);
    if (userIds.length) await safe(() => prisma.user.deleteMany({ where: { id: { in: userIds } } }));
    if (orgId) await safe(() => prisma.organization.deleteMany({ where: { id: orgId } }));
    console.log(`\ncleanup: removed ${TAG} scratch rows`);
    await app.close();
  }

  console.log(`\n${failures === 0 ? "✓ ALL CHECKS PASSED" : `✗ ${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
