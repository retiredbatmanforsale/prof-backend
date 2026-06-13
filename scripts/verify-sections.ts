import { PrismaClient } from "@prisma/client";
import { computeSectionMetrics } from "../src/lib/orgMetrics.js";
const prisma = new PrismaClient();
async function main() {
  const [sections, students, assignments] = await Promise.all([
    prisma.section.count(),
    prisma.sectionStudent.count(),
    prisma.sectionAssignment.count(),
  ]);
  console.log(`sections=${sections} section_students=${students} section_assignments=${assignments}`);
  // computeSectionMetrics on a non-existent id should return null (not throw).
  const none = await computeSectionMetrics(prisma, "does-not-exist");
  console.log(`computeSectionMetrics(missing) => ${none === null ? "null ✅" : "UNEXPECTED"}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
