import type { FastifyRequest, FastifyReply } from "fastify";
import { getOrgAdminInfo } from "../lib/session.js";

/**
 * Guard for the organization metrics dashboard (/org/*). Must run after
 * `authenticate`. Authoritatively re-checks org-admin status against the DB
 * (never trusts the JWT alone), so a revoked org admin loses access on the
 * next request rather than at token expiry. On success, attaches the
 * resolved organization to the request for the downstream handlers.
 *
 * Platform admins (role=ADMIN) may additionally pass ?asOrg=<orgId> to view
 * any organization's dashboard as if they were that org's admin — used by
 * the /admin → "View as university admin" flow. Any other role passing
 * ?asOrg= is rejected with 403 (rather than silently ignored) so callers
 * don't think they got the org they asked for when they didn't.
 */
export async function requireOrgAdmin(
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

  const info = await getOrgAdminInfo(request.server.prisma, userId);
  if (!info.isOrgAdmin || !info.organizationId || !info.organizationName) {
    return reply
      .status(403)
      .send({ error: "Organization admin access required" });
  }

  request.orgAdminContext = {
    organizationId: info.organizationId,
    organizationName: info.organizationName,
  };
}
