import type { FastifyInstance } from "fastify";
import { OrgRole, type PrismaClient } from "@prisma/client";
import { generateToken, hashToken } from "./tokens.js";
import {
  activeOrgWhere,
  campusAdminMembershipWhere,
  FACULTY_TIER_ROLES,
} from "./orgRole.js";
import type { JWTPayload } from "../types/index.js";

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function getAccessInfo(
  prisma: PrismaClient,
  userId: string
): Promise<{
  hasAccess: boolean;
  accessType: "premium" | "subscription" | "institution" | null;
  organizationName: string | null;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isPremium: true, premiumEndsAt: true },
  });

  const now = new Date();

  if (user?.isPremium) {
    // Check if user has an active subscription
    const activeSubscription = await prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: ["ACTIVE", "AUTHENTICATED", "PENDING"] },
      },
      orderBy: { createdAt: "desc" },
    });

    if (activeSubscription) {
      // Has an active subscription — check if within billing period
      if (
        activeSubscription.currentPeriodEnd &&
        activeSubscription.currentPeriodEnd < now
      ) {
        // Period expired (webhook missed) — check for fallbacks before revoking.
        // Order: legacy one-time payment > admin comp grant.
        const hasLegacyPayment = await hasLegacyOneTimePayment(prisma, userId);
        if (hasLegacyPayment) {
          return { hasAccess: true, accessType: "premium", organizationName: null };
        }
        if (
          user.premiumEndsAt === null ||
          (user.premiumEndsAt && user.premiumEndsAt > now)
        ) {
          // Active admin comp (lifetime if null end date, otherwise still in window).
          // Only honor null when we know premiumEndsAt was deliberately set null;
          // legacy users (pre-comp) also have null here, but the legacy check above
          // already filtered them out.
          return { hasAccess: true, accessType: "premium", organizationName: null };
        }
        // No legacy payment, no live comp — revoke access
        await prisma.user.update({
          where: { id: userId },
          data: { isPremium: false, premiumEndsAt: null },
        });
        // Fall through to institution check
      } else {
        return { hasAccess: true, accessType: "subscription", organizationName: null };
      }
    } else {
      // isPremium but no active subscription. Could be:
      //  (a) legacy one-time payer
      //  (b) admin comp (with or without end date)
      // Treat (b) as expired if premiumEndsAt is set and in the past.
      if (user.premiumEndsAt && user.premiumEndsAt < now) {
        await prisma.user.update({
          where: { id: userId },
          data: { isPremium: false, premiumEndsAt: null },
        });
        // Fall through to institution check
      } else {
        return { hasAccess: true, accessType: "premium", organizationName: null };
      }
    }
  }

  const membership = await prisma.organizationMember.findFirst({
    where: {
      userId,
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
    include: {
      organization: { select: { name: true } },
    },
  });

  if (membership) {
    return {
      hasAccess: true,
      accessType: "institution",
      organizationName: membership.organization.name,
    };
  }

  return { hasAccess: false, accessType: null, organizationName: null };
}

/**
 * Resolve a user's organization-admin scope, independent of the access-type
 * branching in getAccessInfo (an org admin may also be a paid/comp user, in
 * which case getAccessInfo short-circuits before reaching the membership
 * lookup). Returns the org the user administers, or nulls if they admin none.
 *
 * Only counts active org-admin memberships of an active organization that is
 * within its access window — a revoked member or an expired org grants no
 * dashboard access.
 */
export async function getOrgAdminInfo(
  prisma: PrismaClient,
  userId: string
): Promise<{
  isOrgAdmin: boolean;
  organizationId: string | null;
  organizationName: string | null;
}> {
  const now = new Date();
  const membership = await prisma.organizationMember.findFirst({
    where: {
      userId,
      ...campusAdminMembershipWhere,
      isActive: true,
      organization: activeOrgWhere(now),
    },
    select: { organization: { select: { id: true, name: true } } },
  });

  if (!membership) {
    return { isOrgAdmin: false, organizationId: null, organizationName: null };
  }
  return {
    isOrgAdmin: true,
    organizationId: membership.organization.id,
    organizationName: membership.organization.name,
  };
}

/**
 * Resolve a user's faculty-tier membership (FACULTY/LAB_ASSISTANT/TA) for the
 * /faculty surface. Only counts an active membership of an active, in-window
 * org. Returns the OrganizationMember id so section queries can scope to the
 * staff member's assignments. Campus admins are NOT faculty — they use /org.
 */
export async function getFacultyInfo(
  prisma: PrismaClient,
  userId: string
): Promise<{
  isFaculty: boolean;
  memberId: string | null;
  organizationId: string | null;
  organizationName: string | null;
}> {
  const now = new Date();
  const membership = await prisma.organizationMember.findFirst({
    where: {
      userId,
      isActive: true,
      orgRole: { in: [...FACULTY_TIER_ROLES] },
      organization: activeOrgWhere(now),
    },
    select: {
      id: true,
      organization: { select: { id: true, name: true } },
    },
  });

  if (!membership) {
    return {
      isFaculty: false,
      memberId: null,
      organizationId: null,
      organizationName: null,
    };
  }
  return {
    isFaculty: true,
    memberId: membership.id,
    organizationId: membership.organization.id,
    organizationName: membership.organization.name,
  };
}

/**
 * Resolve the per-org tier to stamp into a user's JWT: the most-privileged
 * active membership in an active, in-window org. Campus admin wins; otherwise
 * a faculty-tier membership (FACULTY/LAB_ASSISTANT/TA) is surfaced so the
 * frontend can route teaching staff to their dashboard. Returns nulls for a
 * plain student or a user who staffs/admins no org.
 *
 * NOTE: faculty are scoped to specific sections — that scoping lives in a
 * separate (not-yet-built) Section model. This only identifies the tier; it
 * does not grant the /org admin dashboard (requireOrgAdmin still gates on
 * campus admin via getOrgAdminInfo).
 */
export async function getOrgTokenScope(
  prisma: PrismaClient,
  userId: string
): Promise<{
  orgRole: OrgRole | null;
  organizationId: string | null;
  organizationName: string | null;
  isOrgAdmin: boolean;
}> {
  const admin = await getOrgAdminInfo(prisma, userId);
  if (admin.isOrgAdmin) {
    return {
      orgRole: OrgRole.CAMPUS_ADMIN,
      organizationId: admin.organizationId,
      organizationName: admin.organizationName,
      isOrgAdmin: true,
    };
  }

  const now = new Date();
  const staff = await prisma.organizationMember.findFirst({
    where: {
      userId,
      isActive: true,
      orgRole: { in: [...FACULTY_TIER_ROLES] },
      organization: activeOrgWhere(now),
    },
    select: {
      orgRole: true,
      organization: { select: { id: true, name: true } },
    },
  });

  if (!staff) {
    return {
      orgRole: null,
      organizationId: null,
      organizationName: null,
      isOrgAdmin: false,
    };
  }
  return {
    orgRole: staff.orgRole,
    organizationId: staff.organization.id,
    organizationName: staff.organization.name,
    isOrgAdmin: false,
  };
}

async function hasLegacyOneTimePayment(
  prisma: PrismaClient,
  userId: string
): Promise<boolean> {
  const payment = await prisma.payment.findFirst({
    where: {
      userId,
      status: "paid",
    },
  });
  return !!payment;
}

export async function issueTokens(
  app: FastifyInstance,
  user: { id: string; email: string; role: string },
  prisma: PrismaClient
) {
  const { hasAccess, accessType, organizationName } = await getAccessInfo(
    prisma,
    user.id
  );
  const orgScope = await getOrgTokenScope(prisma, user.id);

  const payload: JWTPayload = {
    userId: user.id,
    email: user.email,
    role: user.role as JWTPayload["role"],
    hasAccess,
    accessType,
    // Prefer the access-derived org name; fall back to the org the user
    // administers/staffs so an org member always sees their org name in the token.
    organizationName: organizationName ?? orgScope.organizationName,
    organizationId: orgScope.organizationId,
    isOrgAdmin: orgScope.isOrgAdmin,
    orgRole: orgScope.orgRole,
  };

  const accessToken = app.jwt.sign(payload, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });

  const rawRefreshToken = generateToken();
  const hashedRefresh = hashToken(rawRefreshToken);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      token: hashedRefresh,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS),
    },
  });

  return { accessToken, refreshToken: rawRefreshToken };
}

export async function revokeRefreshToken(
  prisma: PrismaClient,
  rawToken: string,
  rotated = false
) {
  const hashed = hashToken(rawToken);
  await prisma.refreshToken.updateMany({
    where: { token: hashed },
    data: rotated
      ? { isRevoked: true, rotatedAt: new Date() }
      : { isRevoked: true },
  });
}

export async function revokeAllUserTokens(
  prisma: PrismaClient,
  userId: string
) {
  await prisma.refreshToken.updateMany({
    where: { userId, isRevoked: false },
    data: { isRevoked: true },
  });
}
