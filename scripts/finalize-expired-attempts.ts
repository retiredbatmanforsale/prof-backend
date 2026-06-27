// Sweep job — finalize timed-out assessment attempts that were abandoned.
//
// Lazy enforcement (in the attempt routes) closes a timed-out attempt the moment
// an active student touches it. This sweep is the other half: it guarantees that
// EVERY expired attempt is eventually finalized, even if the student never comes
// back. Run on a schedule (e.g. every few minutes) via Cloud Run / cron:
//   npm run job:finalize-expired
import { PrismaClient } from "@prisma/client";
import { isAttemptExpired, autoFinalizeAttempt } from "../src/lib/attemptLifecycle.js";

const prisma = new PrismaClient();

async function main() {
  const now = new Date();
  // Only attempts of assessments that actually have a time limit can expire.
  const open = await prisma.assessmentAttempt.findMany({
    where: {
      status: { in: ["IN_PROGRESS", "EXITED"] },
      assessment: { OR: [{ durationMinutes: { gt: 0 } }, { dueAt: { not: null } }] },
    },
    include: {
      assessment: {
        select: {
          id: true,
          durationMinutes: true,
          dueAt: true,
          questions: { orderBy: { order: "asc" } },
        },
      },
    },
  });

  let finalized = 0;
  for (const attempt of open) {
    if (isAttemptExpired(attempt.assessment, attempt, now)) {
      await autoFinalizeAttempt(prisma, attempt.assessment, attempt);
      finalized++;
    }
  }
  console.log(`[finalize-expired] scanned ${open.length} open attempt(s), finalized ${finalized} expired`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
