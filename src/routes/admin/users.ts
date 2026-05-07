import type { FastifyInstance } from "fastify";
import type { PlanType, Prisma } from "@prisma/client";
import { z } from "zod";
import { getAllPlanConfigs } from "../../lib/plans.js";
import { recordAdminAction } from "../../lib/audit.js";
import { revokeAllUserTokens } from "../../lib/session.js";

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

  // GET /admin/users/:id — full user detail for ops, including the
  // bits we need to render the premium-comp panel (current isPremium
  // state, comp end date, latest subscription period end).
  app.get<{ Params: { id: string } }>(
    "/users/:id",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const user = await app.prisma.user.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          isPremium: true,
          premiumEndsAt: true,
          premiumGrantReason: true,
          createdAt: true,
          subscriptions: {
            orderBy: { createdAt: "desc" },
            take: 5,
            select: {
              id: true,
              planType: true,
              status: true,
              currentPeriodStart: true,
              currentPeriodEnd: true,
              cancelledAt: true,
              endedAt: true,
              pendingPlanType: true,
              pendingPlanChangeAt: true,
              refundedAt: true,
              refundStatus: true,
              createdAt: true,
            },
          },
          organizationMembers: {
            select: {
              id: true,
              isActive: true,
              isVerified: true,
              organization: {
                select: { id: true, name: true, slug: true, accessEndDate: true },
              },
            },
          },
        },
      });

      if (!user) {
        return reply.status(404).send({ error: "User not found" });
      }

      return reply.send({ user });
    }
  );

  // PATCH /admin/users/:id/premium — Grant or revoke premium access.
  // Body: { isPremium: boolean, endsAt?: ISO string | null, reason: string }
  // - On grant: sets isPremium=true and premiumEndsAt to the given date
  //   (null = lifetime comp). Reason is required for the audit log.
  // - On revoke: sets isPremium=false, clears premiumEndsAt, kills the
  //   user's refresh tokens so access collapses on next JWT refresh.
  // Coexists with subscriptions: if the user has an active sub, the
  // sub still governs day-to-day access; the comp is a fallback after
  // the sub period ends or when no sub exists.
  app.patch<{ Params: { id: string } }>(
    "/users/:id/premium",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = premiumGrantSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const user = await app.prisma.user.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          email: true,
          isPremium: true,
          premiumEndsAt: true,
          premiumGrantReason: true,
        },
      });
      if (!user) {
        return reply.status(404).send({ error: "User not found" });
      }

      const { isPremium, endsAt, reason } = parsed.data;
      const previous = {
        isPremium: user.isPremium,
        premiumEndsAt: user.premiumEndsAt,
        premiumGrantReason: user.premiumGrantReason,
      };

      const data: Prisma.UserUpdateInput = isPremium
        ? {
            isPremium: true,
            premiumEndsAt: endsAt ? new Date(endsAt) : null,
            premiumGrantReason: reason,
          }
        : {
            isPremium: false,
            premiumEndsAt: null,
            premiumGrantReason: reason,
          };

      const updated = await app.prisma.user.update({
        where: { id: user.id },
        data,
        select: {
          id: true,
          email: true,
          isPremium: true,
          premiumEndsAt: true,
          premiumGrantReason: true,
        },
      });

      // On revoke, kill refresh tokens so any cached "premium" JWT can't
      // outlive the change beyond the 15-minute access token TTL.
      if (!isPremium) {
        await revokeAllUserTokens(app.prisma, user.id);
      }

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: isPremium ? "PREMIUM_GRANT" : "PREMIUM_REVOKE",
        entityType: "USER",
        entityId: user.id,
        metadata: {
          targetEmail: user.email,
          previous,
          next: {
            isPremium: updated.isPremium,
            premiumEndsAt: updated.premiumEndsAt?.toISOString() ?? null,
            premiumGrantReason: updated.premiumGrantReason,
          },
          reason,
        },
        log: request.log,
      });

      return reply.send({ success: true, user: updated });
    }
  );
}

const premiumGrantSchema = z
  .object({
    isPremium: z.boolean(),
    endsAt: z.string().datetime().nullish(),
    reason: z.string().min(3, "Reason is required").max(500),
  })
  .refine(
    (data) => {
      if (data.isPremium && data.endsAt) {
        return new Date(data.endsAt) > new Date();
      }
      return true;
    },
    { message: "End date must be in the future", path: ["endsAt"] }
  );

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
