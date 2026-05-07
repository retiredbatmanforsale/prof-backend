// Standalone runner for the institution expiry-warning email job.
// Usage (production cron):  tsx scripts/send-expiry-notices.ts
// Or hit POST /admin/jobs/expiry-notices with an admin token.

import { PrismaClient } from "@prisma/client";
import { runExpiryNoticeJob } from "../src/lib/expiry-notices.js";

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await runExpiryNoticeJob(prisma);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
