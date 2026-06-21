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
export type SectionLinkResult =
  | "linked" // SectionStudent created
  | "already-in-this-cohort" // idempotent re-claim of the same cohort
  | "rejected-other-cohort" // ONE-COHORT rule: already in a different cohort
  | "no-section" // preload carried no cohort intent
  | "no-member"; // membership not found (defensive)

export async function linkPreloadedSectionOnClaim(
  prisma: PrismaClient,
  preloaded: { sectionId: string | null; organizationId: string },
  userId: string
): Promise<SectionLinkResult> {
  if (!preloaded.sectionId) return "no-section";

  const member = await prisma.organizationMember.findUnique({
    where: {
      userId_organizationId: {
        userId,
        organizationId: preloaded.organizationId,
      },
    },
    select: { id: true },
  });
  if (!member) return "no-member";

  // ── ONE-COHORT ENFORCEMENT (mandatory) ─────────────────────────────────────
  // A student may belong to only ONE cohort (Section). Before attaching, check
  // whether this member already has ANY SectionStudent row. If they're already
  // in a *different* cohort, reject — never create a second membership. Same
  // cohort = idempotent no-op (safe re-claim). Callers that auto-claim on login
  // (auth/login.ts) ignore the result; the explicit accept route surfaces a 409.
  const existing = await prisma.sectionStudent.findFirst({
    where: { organizationMemberId: member.id },
    select: { sectionId: true },
  });
  if (existing) {
    return existing.sectionId === preloaded.sectionId
      ? "already-in-this-cohort"
      : "rejected-other-cohort";
  }

  await prisma.sectionStudent.create({
    data: {
      sectionId: preloaded.sectionId,
      organizationMemberId: member.id,
    },
  });
  return "linked";
}
