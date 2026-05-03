import type { FastifyInstance } from "fastify";
import type { PlanType } from "@prisma/client";
import { getAllPlanConfigs } from "../../lib/plans.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function dashboardRoutes(app: FastifyInstance) {
  // GET /admin/dashboard — KPI numbers strip.
  // Auth + admin guard are applied at the parent (admin/index.ts).
  app.get(
    "/dashboard",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (_request, reply) => {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);

      // Plan price lookup (paise) — read once from env-driven config.
      const planPrices: Record<PlanType, number> = {
        MONTHLY: 0,
        QUARTERLY: 0,
        YEARLY: 0,
      };
      for (const cfg of getAllPlanConfigs()) {
        planPrices[cfg.planType] = cfg.price;
      }

      // ── 1. Top-line user counts ─────────────────────────────────
      const [totalUsers, newUsers7d, totalUsers7dAgo] = await Promise.all([
        app.prisma.user.count(),
        app.prisma.user.count({
          where: { createdAt: { gte: sevenDaysAgo } },
        }),
        app.prisma.user.count({
          where: { createdAt: { lt: sevenDaysAgo } },
        }),
      ]);

      // ── 2. Active paid subscribers (deduped per user) ───────────
      // "Active" = status in (ACTIVE, AUTHENTICATED, PENDING) AND not refunded
      // AND (period not yet expired OR period not yet set). Cancelled-but-still-
      // in-period subs are still counted as active paid (they're paying users
      // who chose not to renew — they remain in MRR until period end).
      const activeSubs = await app.prisma.subscription.findMany({
        where: {
          status: { in: ["ACTIVE", "AUTHENTICATED", "PENDING"] },
          refundedAt: null,
          OR: [
            { currentPeriodEnd: null },
            { currentPeriodEnd: { gt: now } },
          ],
        },
        select: { userId: true, planType: true, createdAt: true, firstPaymentAt: true },
        orderBy: { createdAt: "desc" },
      });

      // Dedupe by userId — a user with multiple historical subs only counts once.
      const seenUsers = new Set<string>();
      const paidByPlan: Record<PlanType, number> = { MONTHLY: 0, QUARTERLY: 0, YEARLY: 0 };
      for (const s of activeSubs) {
        if (seenUsers.has(s.userId)) continue;
        seenUsers.add(s.userId);
        paidByPlan[s.planType]++;
      }
      const paidActive = seenUsers.size;

      // ── 3. Institution learners (active, verified, within window) ──
      const institutionActive = await app.prisma.organizationMember.count({
        where: {
          isActive: true,
          isVerified: true,
          organization: {
            isActive: true,
            OR: [{ accessStartDate: null }, { accessStartDate: { lte: now } }],
            AND: {
              OR: [{ accessEndDate: null }, { accessEndDate: { gte: now } }],
            },
          },
        },
      });

      // Free signups = total users minus paid + institution. Approximation:
      // a user could be both an institution member AND a paid subscriber (rare),
      // in which case we'd undercount free. Acceptable for a strip number.
      const freeSignups = Math.max(totalUsers - paidActive - institutionActive, 0);

      // ── 4. MRR — monthly equivalent revenue from active subs ────
      let mrrPaise = 0;
      for (const planType of ["MONTHLY", "QUARTERLY", "YEARLY"] as PlanType[]) {
        const months = planType === "MONTHLY" ? 1 : planType === "QUARTERLY" ? 3 : 12;
        mrrPaise += Math.floor(planPrices[planType] / months) * paidByPlan[planType];
      }

      // ── 5. New paid this week (count + ₹ collected) ─────────────
      const newPaidSubs = await app.prisma.subscription.findMany({
        where: {
          firstPaymentAt: { gte: sevenDaysAgo },
          status: { in: ["ACTIVE", "AUTHENTICATED", "PENDING"] },
          refundedAt: null,
        },
        select: { planType: true },
      });
      const newPaidCount = newPaidSubs.length;
      const newPaidRevenuePaise = newPaidSubs.reduce(
        (sum, s) => sum + planPrices[s.planType],
        0
      );

      // ── 6. Refund rate (last 30 days) ───────────────────────────
      // Denominator: subs whose first payment landed in last 30 days.
      // Numerator: refunds processed in last 30 days. Both bounded to the
      // same window so the ratio is comparable.
      const [paid30d, refunded30d] = await Promise.all([
        app.prisma.subscription.count({
          where: { firstPaymentAt: { gte: thirtyDaysAgo } },
        }),
        app.prisma.subscription.count({
          where: { refundedAt: { gte: thirtyDaysAgo } },
        }),
      ]);
      const refundRatePct = paid30d > 0 ? (refunded30d / paid30d) * 100 : 0;

      // ── Pulse: last 24h ─────────────────────────────────────────
      const oneDayAgo = new Date(now.getTime() - DAY_MS);
      const [pulseSignups, pulsePaid, pulseCancelled, pulseRefunded] = await Promise.all([
        app.prisma.user.count({ where: { createdAt: { gte: oneDayAgo } } }),
        app.prisma.subscription.count({
          where: { firstPaymentAt: { gte: oneDayAgo } },
        }),
        app.prisma.subscription.count({
          where: { cancelledAt: { gte: oneDayAgo } },
        }),
        app.prisma.subscription.count({
          where: { refundedAt: { gte: oneDayAgo } },
        }),
      ]);

      return reply.send({
        signups: {
          total: totalUsers,
          newLast7d: newUsers7d,
          // % growth = new7d / (total - new7d) — interpretable as "we grew X%
          // off the existing base in the past week."
          growthPct:
            totalUsers7dAgo > 0
              ? Math.round((newUsers7d / totalUsers7dAgo) * 1000) / 10
              : null,
        },
        paid: {
          active: paidActive,
          byPlan: paidByPlan,
        },
        institution: {
          active: institutionActive,
        },
        free: {
          signups: freeSignups,
        },
        mrr: {
          paise: mrrPaise,
          rupees: Math.floor(mrrPaise / 100),
        },
        newPaidThisWeek: {
          count: newPaidCount,
          revenuePaise: newPaidRevenuePaise,
          revenueRupees: Math.floor(newPaidRevenuePaise / 100),
        },
        refundRate30d: {
          refunded: refunded30d,
          paid: paid30d,
          pct: Math.round(refundRatePct * 10) / 10,
        },
        pulse24h: {
          signups: pulseSignups,
          paid: pulsePaid,
          cancelled: pulseCancelled,
          refunded: pulseRefunded,
        },
        generatedAt: now.toISOString(),
      });
    }
  );
}
