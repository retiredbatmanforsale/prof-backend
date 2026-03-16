import type { Role } from "@prisma/client";

export interface JWTPayload {
  userId: string;
  email: string;
  role: Role;
  hasAccess: boolean;
  accessType: "premium" | "subscription" | "institution" | null;
  organizationName: string | null;
}

export interface GoogleUserPayload {
  sub: string;
  name: string;
  email: string;
  email_verified: boolean;
  picture?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    currentUser?: JWTPayload;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JWTPayload;
    user: JWTPayload;
  }
}
