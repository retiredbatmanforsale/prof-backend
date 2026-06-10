import type { PrismaClient } from "@prisma/client";

/**
 * On invite claim / auto-claim, materialize the cohort link a roster CSV
 * recorded on the PreloadedStudent (PreloadedStudent.sectionId) into a real
 * SectionStudent row, now that the student has an OrganizationMember. No-op if
 * the student wasn't cohorted, or if (defensively) their membership isn't found
 * yet. Idempotent — safe to call on every (re)claim.
 *
 * Call AFTER the membership upsert/transaction completes (it looks the member
 * up by the unique (userId, organizationId)).
 */
export async function linkPreloadedSectionOnClaim(
  prisma: PrismaClient,
  preloaded: { sectionId: string | null; organizationId: string },
  userId: string
): Promise<void> {
  if (!preloaded.sectionId) return;

  const member = await prisma.organizationMember.findUnique({
    where: {
      userId_organizationId: {
        userId,
        organizationId: preloaded.organizationId,
      },
    },
    select: { id: true },
  });
  if (!member) return;

  await prisma.sectionStudent.upsert({
    where: {
      sectionId_organizationMemberId: {
        sectionId: preloaded.sectionId,
        organizationMemberId: member.id,
      },
    },
    create: {
      sectionId: preloaded.sectionId,
      organizationMemberId: member.id,
    },
    update: {},
  });
}
