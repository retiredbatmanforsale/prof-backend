import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  for (const table of ['organization_members', 'preloaded_students'] as const) {
    const rows = await prisma.$queryRawUnsafe<Array<{ orgRole: string; isOrgAdmin: boolean; n: bigint }>>(
      `SELECT "orgRole", "isOrgAdmin", COUNT(*)::int AS n FROM "${table}" GROUP BY "orgRole", "isOrgAdmin" ORDER BY "orgRole", "isOrgAdmin"`
    );
    console.log(`\n=== ${table} ===`);
    if (rows.length === 0) { console.log('  (no rows)'); continue; }
    for (const r of rows) console.log(`  orgRole=${r.orgRole.padEnd(14)} isOrgAdmin=${String(r.isOrgAdmin).padEnd(5)} → ${r.n}`);
    const mismatch = rows.filter(r => r.isOrgAdmin && r.orgRole !== 'CAMPUS_ADMIN');
    console.log(mismatch.length ? `  ⚠️  ${mismatch.length} admin row-group(s) NOT CAMPUS_ADMIN` : '  ✅ all isOrgAdmin=true rows are CAMPUS_ADMIN');
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
