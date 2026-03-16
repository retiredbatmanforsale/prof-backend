import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { generateToken, hashToken } from "./tokens.js";
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
    select: { isPremium: true },
  });

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
        activeSubscription.currentPeriodEnd < new Date()
      ) {
        // Period expired (webhook missed) — check for legacy one-time payments before revoking
        const hasLegacyPayment = await hasLegacyOneTimePayment(prisma, userId);
        if (hasLegacyPayment) {
          return { hasAccess: true, accessType: "premium", organizationName: null };
        }
        // No legacy payment — revoke access
        await prisma.user.update({
          where: { id: userId },
          data: { isPremium: false },
        });
        // Fall through to institution check
      } else {
        return { hasAccess: true, accessType: "subscription", organizationName: null };
      }
    } else {
      // isPremium but no active subscription — legacy one-time premium user
      return { hasAccess: true, accessType: "premium", organizationName: null };
    }
  }

  const membership = await prisma.organizationMember.findFirst({
    where: {
      userId,
      isActive: true,
      isVerified: true,
      organization: { isActive: true },
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

  const payload: JWTPayload = {
    userId: user.id,
    email: user.email,
    role: user.role as JWTPayload["role"],
    hasAccess,
    accessType,
    organizationName,
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
  rawToken: string
) {
  const hashed = hashToken(rawToken);
  await prisma.refreshToken.updateMany({
    where: { token: hashed },
    data: { isRevoked: true },
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
