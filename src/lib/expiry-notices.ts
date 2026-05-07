import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { sendInstitutionExpiryWarning } from "./email.js";

// Two heads-ups: a week out, then the day before. The 0-day flip happens
// automatically via getAccessInfo's date check, so we don't need a "today
// you've lost access" email — that surface is the paywall itself.
const NOTICE_WINDOWS: Array<{ kind: string; daysBefore: number }> = [
  { kind: "WARNING_7D", daysBefore: 7 },
  { kind: "WARNING_1D", daysBefore: 1 },
];

export interface ExpiryNoticeRunResult {
  scanned: number;
  sent: number;
  skippedDuplicate: number;
  errors: Array<{ memberId: string; kind: string; error: string }>;
}

// Find institution members whose org's accessEndDate falls within an
// upcoming notice window and email them a heads-up. Idempotent across
// runs: a unique (member, kind, targetEndDate) row is claimed before the
// email is sent so a duplicate run is a cheap no-op.
export async function runExpiryNoticeJob(
  prisma: PrismaClient,
  log?: FastifyBaseLogger,
  now: Date = new Date()
): Promise<ExpiryNoticeRunResult> {
  const result: ExpiryNoticeRunResult = {
    scanned: 0,
    sent: 0,
    skippedDuplicate: 0,
    errors: [],
  };

  for (const window of NOTICE_WINDOWS) {
    // We accept anything ending strictly within (now, now + daysBefore]
    // for the latest applicable window. The unique constraint on
    // (member, kind, targetEndDate) guarantees we only send once per
    // upcoming end date — extending the org pushes a new targetEndDate
    // and re-arms the warning, which is the desired behaviour.
    const upperBound = new Date(now);
    upperBound.setDate(upperBound.getDate() + window.daysBefore);

    const members = await prisma.organizationMember.findMany({
      where: {
        isActive: true,
        isVerified: true,
        organization: {
          isActive: true,
          accessEndDate: {
            gt: now,
            lte: upperBound,
          },
        },
      },
      include: {
        user: { select: { email: true } },
        organization: {
          select: { name: true, accessEndDate: true },
        },
      },
    });

    for (const member of members) {
      result.scanned++;
      const endDate = member.organization.accessEndDate;
      if (!endDate) continue;

      try {
        // Claim the slot first. A unique-constraint violation means
        // another run already sent this notice — skip silently.
        await prisma.expiryNoticeLog.create({
          data: {
            organizationMemberId: member.id,
            kind: window.kind,
            targetEndDate: endDate,
          },
        });
      } catch (err: any) {
        if (err?.code === "P2002") {
          result.skippedDuplicate++;
          continue;
        }
        log?.error(
          { err, memberId: member.id, kind: window.kind },
          "Expiry notice: failed to write log row"
        );
        result.errors.push({
          memberId: member.id,
          kind: window.kind,
          error: err?.message ?? "log_write_failed",
        });
        continue;
      }

      const daysRemaining = Math.max(
        0,
        Math.round((endDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      );

      try {
        await sendInstitutionExpiryWarning(
          member.user.email,
          member.organization.name,
          endDate,
          daysRemaining
        );
        result.sent++;
      } catch (err: any) {
        log?.error(
          { err, memberId: member.id, kind: window.kind },
          "Expiry notice: email send failed (log row already created — manual retry needed)"
        );
        result.errors.push({
          memberId: member.id,
          kind: window.kind,
          error: err?.message ?? "email_send_failed",
        });
      }
    }
  }

  log?.info(result, "Expiry notice job complete");
  return result;
}
