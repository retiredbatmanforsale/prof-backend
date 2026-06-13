import type { Role, OrgRole } from "@prisma/client";

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
  // Canonical per-org tier for `organizationId`. CAMPUS_ADMIN mirrors
  // isOrgAdmin=true; FACULTY/LAB_ASSISTANT/TA let the frontend route staff to
  // their (section-scoped) dashboard; null when the user administers/staffs no
  // org. The backend guard re-checks the DB and never trusts this alone.
  orgRole: OrgRole | null;
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
    // Set by the requireFaculty hook after an authoritative DB check. Faculty
    // routes read memberId to scope queries to the staff member's assigned
    // sections (a faculty member sees only those).
    facultyContext?: {
      organizationId: string;
      organizationName: string;
      memberId: string;
    };
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JWTPayload;
    user: JWTPayload;
  }
}
