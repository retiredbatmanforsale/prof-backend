import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding auth-service database...\n");

  // ─── 1. Create a test user with password (email/password login flow) ───
  const hashedPassword = await bcrypt.hash("testpass123", 12);

  const testUser = await prisma.user.upsert({
    where: { email: "test@example.com" },
    update: {},
    create: {
      name: "Test User",
      email: "test@example.com",
      hashedPassword,
      emailVerified: new Date(),
      role: "USER",
      isPremium: false,
    },
  });
  console.log(`[User] Created test user: ${testUser.email} (password: testpass123)`);

  // ─── 2. Create a premium user (already paid) ───
  const premiumUser = await prisma.user.upsert({
    where: { email: "premium@example.com" },
    update: {},
    create: {
      name: "Premium User",
      email: "premium@example.com",
      hashedPassword,
      emailVerified: new Date(),
      role: "USER",
      isPremium: true,
    },
  });
  console.log(`[User] Created premium user: ${premiumUser.email} (isPremium: true)`);

  // ─── 3. Create an admin user ───
  const adminUser = await prisma.user.upsert({
    where: { email: "admin@lexailabs.com" },
    update: {},
    create: {
      name: "Admin User",
      email: "admin@lexailabs.com",
      hashedPassword,
      emailVerified: new Date(),
      role: "ADMIN",
      isPremium: true,
    },
  });
  console.log(`[User] Created admin user: ${adminUser.email}`);

  // ─── 4. Create an unverified user (email not verified) ───
  const unverifiedUser = await prisma.user.upsert({
    where: { email: "unverified@example.com" },
    update: {},
    create: {
      name: "Unverified User",
      email: "unverified@example.com",
      hashedPassword,
      role: "USER",
      // emailVerified is null — login should return EMAIL_NOT_VERIFIED
    },
  });
  console.log(`[User] Created unverified user: ${unverifiedUser.email} (emailVerified: null)`);

  // ─── 5. Create a B2B Organization ───
  const threeMonthsFromNow = new Date();
  threeMonthsFromNow.setMonth(threeMonthsFromNow.getMonth() + 3);

  const org = await prisma.organization.upsert({
    where: { slug: "acme-university" },
    update: {},
    create: {
      name: "Acme University",
      slug: "acme-university",
      emailDomains: ["acme.edu", "acmeuniversity.edu"],
      isActive: true,
      accessStartDate: new Date(),
      accessEndDate: threeMonthsFromNow,
    },
  });
  console.log(`[Org] Created organization: ${org.name} (domains: ${org.emailDomains.join(", ")})`);

  // ─── 6. Pre-load student emails for B2B flow ───
  const preloadedStudents = [
    { email: "alice@acme.edu", name: "Alice Johnson" },
    { email: "bob@acme.edu", name: "Bob Smith" },
    { email: "charlie@acme.edu", name: "Charlie Brown" },
    { email: "student1@acmeuniversity.edu", name: null },
    { email: "student2@acmeuniversity.edu", name: null },
  ];

  for (const { email, name } of preloadedStudents) {
    await prisma.preloadedStudent.upsert({
      where: {
        organizationId_email: {
          organizationId: org.id,
          email,
        },
      },
      update: {},
      create: {
        email,
        name,
        organizationId: org.id,
        claimed: false,
      },
    });
  }
  console.log(`[B2B] Pre-loaded ${preloadedStudents.length} student emails for ${org.name}`);

  // ─── 7. Create a B2B user who already has institutional access ───
  const b2bUser = await prisma.user.upsert({
    where: { email: "existing-student@acme.edu" },
    update: {},
    create: {
      name: "Existing B2B Student",
      email: "existing-student@acme.edu",
      hashedPassword,
      emailVerified: new Date(),
      role: "USER",
      isPremium: false,
    },
  });

  await prisma.organizationMember.upsert({
    where: {
      userId_organizationId: {
        userId: b2bUser.id,
        organizationId: org.id,
      },
    },
    update: {},
    create: {
      userId: b2bUser.id,
      organizationId: org.id,
      isVerified: true,
      isActive: true,
    },
  });
  console.log(`[B2B] Created B2B user with institutional access: ${b2bUser.email}`);

  // ─── 8. Second organization (inactive) for edge case testing ───
  const inactiveOrg = await prisma.organization.upsert({
    where: { slug: "old-institute" },
    update: {},
    create: {
      name: "Old Institute (Inactive)",
      slug: "old-institute",
      emailDomains: ["oldinstitute.edu"],
      isActive: false,
    },
  });

  await prisma.preloadedStudent.upsert({
    where: {
      organizationId_email: {
        organizationId: inactiveOrg.id,
        email: "student@oldinstitute.edu",
      },
    },
    update: {},
    create: {
      email: "student@oldinstitute.edu",
      organizationId: inactiveOrg.id,
      claimed: false,
    },
  });
  console.log(`[B2B] Created inactive org: ${inactiveOrg.name} (should NOT grant access)`);

  // ─── Summary ───
  console.log("\n========================================");
  console.log("SEED COMPLETE — Test Accounts:");
  console.log("========================================");
  console.log("");
  console.log("Email/Password Login (all use password: testpass123):");
  console.log("  test@example.com       → No access (needs payment)");
  console.log("  premium@example.com    → Has premium access");
  console.log("  admin@lexailabs.com    → Admin + premium");
  console.log("  unverified@example.com → Email not verified (login blocked)");
  console.log("  existing-student@acme.edu → B2B institutional access");
  console.log("");
  console.log("B2B Auto-Access (register/login with these to test):");
  console.log("  alice@acme.edu         → Will get auto institutional access");
  console.log("  bob@acme.edu           → Will get auto institutional access");
  console.log("  charlie@acme.edu       → Will get auto institutional access");
  console.log("");
  console.log("Edge Cases:");
  console.log("  student@oldinstitute.edu → Org is inactive, should NOT get access");
  console.log("========================================\n");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
