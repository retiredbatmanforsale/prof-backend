import type { Role } from "@prisma/client";

export interface JWTPayload {
  userId: string;
  email: string;
  role: Role;
  hasAccess: boolean;
  accessType: "premium" | "subscription" | "institution" | null;
  organizationName: string | null;
  // Org-admin scope. Lets the frontend decide whether to surface the
  // organization metrics dashboard without an extra round-trip. The
  // backend guard re-checks this against the DB and never trusts the
  // token alone for authorization.
  organizationId: string | null;
  isOrgAdmin: boolean;
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
    // Set by the requireOrgAdmin hook after an authoritative DB check.
    // Org-scoped routes read this to know which organization to query.
    orgAdminContext?: {
      organizationId: string;
      organizationName: string;
    };
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JWTPayload;
    user: JWTPayload;
  }
}
