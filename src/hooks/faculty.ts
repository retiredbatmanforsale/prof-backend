import type { FastifyRequest, FastifyReply } from "fastify";
import { getStaffOrgInfo } from "../lib/session.js";

/**
 * The single guard for the unified faculty surface (/faculty/*). Must run after
 * `authenticate`.
 *
 * FLAT HIERARCHY: any org STAFF member may access it — CAMPUS_ADMIN, FACULTY,
 * LAB_ASSISTANT, TA (and the legacy isOrgAdmin boolean) are all treated
 * identically. There is no campus-admin/faculty split. Authoritatively
 * re-checks membership against the DB (never trusts the JWT alone), so a
 * demoted/removed member loses access on the next request, not at token expiry.
 *
 * Platform admins (role=ADMIN) may pass ?asOrg=<orgId> to view any org's
 * dashboard — the /admin → "View as university admin" flow. Any other role
 * passing ?asOrg= is rejected with 403 so callers don't think they got the org
 * they asked for when they didn't.
 *
 * On success sets request.orgAdminContext (the org the caller staffs) — every
 * org/* handler reads this to scope its queries. It also sets
 * request.facultyContext carrying the OrganizationMember id, for section
 * scoping.
 */
export async function requireFaculty(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const userId = request.currentUser?.userId;
  if (!userId) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const asOrg = (request.query as { asOrg?: string } | undefined)?.asOrg;
  if (asOrg) {
    if (request.currentUser?.role !== "ADMIN") {
      return reply
        .status(403)
        .send({ error: "Platform admin access required to view another org" });
    }
    const org = await request.server.prisma.organization.findUnique({
      where: { id: asOrg },
      select: { id: true, name: true },
    });
    if (!org) {
      return reply.status(404).send({ error: "Organization not found" });
    }
    request.orgAdminContext = {
      organizationId: org.id,
      organizationName: org.name,
    };
    return;
  }

  const info = await getStaffOrgInfo(request.server.prisma, userId);
  if (
    !info.isStaff ||
    !info.memberId ||
    !info.organizationId ||
    !info.organizationName
  ) {
    return reply.status(403).send({ error: "Faculty access required" });
  }

  request.orgAdminContext = {
    organizationId: info.organizationId,
    organizationName: info.organizationName,
  };
  request.facultyContext = {
    organizationId: info.organizationId,
    organizationName: info.organizationName,
    memberId: info.memberId,
  };
}
