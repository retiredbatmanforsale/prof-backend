import type { FastifyRequest, FastifyReply } from "fastify";
import { getOrgAdminInfo } from "../lib/session.js";

/**
 * Guard for the organization metrics dashboard (/org/*). Must run after
 * `authenticate`. Authoritatively re-checks org-admin status against the DB
 * (never trusts the JWT alone), so a revoked org admin loses access on the
 * next request rather than at token expiry. On success, attaches the
 * resolved organization to the request for the downstream handlers.
 */
export async function requireOrgAdmin(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const userId = request.currentUser?.userId;
  if (!userId) {
    return reply.status(401).send({ error: "Unauthorized" });
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
