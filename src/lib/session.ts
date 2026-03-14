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
  accessType: "premium" | "institution" | null;
  organizationName: string | null;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isPremium: true },
  });

  if (user?.isPremium) {
    return { hasAccess: true, accessType: "premium", organizationName: null };
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
