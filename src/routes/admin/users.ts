import type { FastifyInstance } from "fastify";
import type { PlanType, Prisma } from "@prisma/client";
import { getAllPlanConfigs } from "../../lib/plans.js";

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

type Tier = "free" | "paid" | "institution";

export default async function usersDirectoryRoutes(app: FastifyInstance) {
  // GET /admin/users — directory listing for ops visibility.
  // Query: tier=free|paid|institution (required), search?, limit?, offset?
  // Auth + admin guard are applied at the parent (admin/index.ts).
  app.get(
    "/users",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const q = request.query as {
        tier?: string;
        search?: string;
        limit?: string;
        offset?: string;
      };

      const tier = q.tier as Tier | undefined;
      if (!tier || !["free", "paid", "institution"].includes(tier)) {
        return reply.status(400).send({
          error: "tier query param required: free | paid | institution",
        });
      }

      const limit = Math.min(
        Math.max(parseInt(q.limit ?? "", 10) || DEFAULT_PAGE_SIZE, 1),
        MAX_PAGE_SIZE
      );
      const offset = Math.max(parseInt(q.offset ?? "", 10) || 0, 0);
      const search = (q.search ?? "").trim();

      const searchFilter: Prisma.UserWhereInput | null =
        search.length > 0
          ? {
              OR: [
                { email: { contains: search, mode: "insensitive" as const } },
                { name: { contains: search, mode: "insensitive" as const } },
                { phone: { contains: search } },
              ],
            }
          : null;

      const now = new Date();

      if (tier === "paid") {
        return await listPaid(app, { searchFilter, limit, offset, now }, reply);
      }
      if (tier === "institution") {
        return await listInstitution(app, { searchFilter, limit, offset, now }, reply);
      }
      return await listFree(app, { searchFilter, limit, offset, now }, reply);
    }
  );
}

interface ListArgs {
  searchFilter: Prisma.UserWhereInput | null;
  limit: number;
  offset: number;
  now: Date;
}

async function listPaid(
  app: FastifyInstance,
  { searchFilter, limit, offset, now }: ListArgs,
  reply: import("fastify").FastifyReply
) {
  // Plan price lookup for monthly contribution.
  const planPrices: Record<PlanType, number> = {
    MONTHLY: 0,
    QUARTERLY: 0,
    YEARLY: 0,
  };
  for (const cfg of getAllPlanConfigs()) {
    planPrices[cfg.planType] = cfg.price;
  }

  // Find users with at least one active subscription. We filter on the user
  // and join the most recent subscription to enrich the row.
  const where: Prisma.UserWhereInput = {
    AND: [
      {
        subscriptions: {
          some: {
            status: { in: ["ACTIVE", "AUTHENTICATED", "PENDING"] },
            refundedAt: null,
            OR: [
              { currentPeriodEnd: null },
              { currentPeriodEnd: { gt: now } },
            ],
          },
        },
      },
      ...(searchFilter ? [searchFilter] : []),
    ],
  };

  const [total, users] = await Promise.all([
    app.prisma.user.count({ where }),
    app.prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
        subscriptions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            planType: true,
            status: true,
            currentPeriodEnd: true,
            cancelledAt: true,
            refundedAt: true,
            refundStatus: true,
            firstPaymentAt: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);

  const rows = users.map((u) => {
    const sub = u.subscriptions[0];
    const months = sub
      ? sub.planType === "MONTHLY"
        ? 1
        : sub.planType === "QUARTERLY"
          ? 3
          : 12
      : 1;
    const monthlyValuePaise = sub
      ? Math.floor(planPrices[sub.planType] / months)
      : 0;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      signedUpAt: u.createdAt,
      planType: sub?.planType ?? null,
      status: sub?.status ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      cancelledAt: sub?.cancelledAt ?? null,
      firstPaymentAt: sub?.firstPaymentAt ?? null,
      monthlyValuePaise,
    };
  });

  return reply.send({ tier: "paid", total, limit, offset, users: rows });
}

async function listInstitution(
  app: FastifyInstance,
  { searchFilter, limit, offset, now }: ListArgs,
  reply: import("fastify").FastifyReply
) {
  const where: Prisma.UserWhereInput = {
    AND: [
      {
        organizationMembers: {
          some: {
            isActive: true,
            isVerified: true,
            organization: {
              isActive: true,
              OR: [
                { accessStartDate: null },
                { accessStartDate: { lte: now } },
              ],
              AND: {
                OR: [
                  { accessEndDate: null },
                  { accessEndDate: { gte: now } },
                ],
              },
            },
          },
        },
      },
      ...(searchFilter ? [searchFilter] : []),
    ],
  };

  const [total, users] = await Promise.all([
    app.prisma.user.count({ where }),
    app.prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
        organizationMembers: {
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            isVerified: true,
            createdAt: true,
            organization: { select: { name: true, slug: true } },
          },
        },
      },
    }),
  ]);

  const rows = users.map((u) => {
    const m = u.organizationMembers[0];
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      signedUpAt: u.createdAt,
      organizationName: m?.organization.name ?? null,
      organizationSlug: m?.organization.slug ?? null,
      isVerified: m?.isVerified ?? false,
      joinedOrgAt: m?.createdAt ?? null,
    };
  });

  return reply.send({ tier: "institution", total, limit, offset, users: rows });
}

async function listFree(
  app: FastifyInstance,
  { searchFilter, limit, offset, now }: ListArgs,
  reply: import("fastify").FastifyReply
) {
  // Free = no active subscription AND no active institution membership AND
  // not flagged as premium. We express this with NOT clauses on those
  // relations so a single user query can find all free users.
  const where: Prisma.UserWhereInput = {
    AND: [
      { isPremium: false },
      {
        subscriptions: {
          none: {
            status: { in: ["ACTIVE", "AUTHENTICATED", "PENDING"] },
            refundedAt: null,
            OR: [
              { currentPeriodEnd: null },
              { currentPeriodEnd: { gt: now } },
            ],
          },
        },
      },
      {
        organizationMembers: {
          none: {
            isActive: true,
            isVerified: true,
            organization: {
              isActive: true,
              OR: [
                { accessStartDate: null },
                { accessStartDate: { lte: now } },
              ],
              AND: {
                OR: [
                  { accessEndDate: null },
                  { accessEndDate: { gte: now } },
                ],
              },
            },
          },
        },
      },
      ...(searchFilter ? [searchFilter] : []),
    ],
  };

  const [total, users] = await Promise.all([
    app.prisma.user.count({ where }),
    app.prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
        emailVerified: true,
        oauthAccounts: { select: { provider: true } },
      },
    }),
  ]);

  const rows = users.map((u) => {
    const daysSinceSignup = Math.floor(
      (now.getTime() - u.createdAt.getTime()) / (24 * 60 * 60 * 1000)
    );
    const providers = u.oauthAccounts.map((o) => o.provider);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      signedUpAt: u.createdAt,
      daysSinceSignup,
      emailVerified: !!u.emailVerified,
      signupSource:
        providers.length > 0
          ? providers.join("+")
          : "email",
    };
  });

  return reply.send({ tier: "free", total, limit, offset, users: rows });
}
