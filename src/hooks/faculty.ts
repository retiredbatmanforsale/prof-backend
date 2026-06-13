import type { FastifyRequest, FastifyReply } from "fastify";
import { getFacultyInfo } from "../lib/session.js";

/**
 * Guard for the faculty surface (/faculty/*). Must run after `authenticate`.
 * Authoritatively re-checks faculty-tier membership against the DB (never
 * trusts the JWT alone), so a demoted/removed staff member loses access on the
 * next request rather than at token expiry. On success, attaches the resolved
 * org + the OrganizationMember id so handlers can scope queries to the staff
 * member's assigned sections.
 *
 * Campus admins are intentionally NOT granted here — they manage all sections
 * via the /org surface. Per-section authorization (a faculty member may only
 * see sections assigned to them) is enforced in each handler against
 * SectionAssignment, not here.
 */
export async function requireFaculty(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const userId = request.currentUser?.userId;
  if (!userId) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const info = await getFacultyInfo(request.server.prisma, userId);
  if (!info.isFaculty || !info.memberId || !info.organizationId) {
    return reply.status(403).send({ error: "Faculty access required" });
  }

  request.facultyContext = {
    organizationId: info.organizationId,
    organizationName: info.organizationName!,
    memberId: info.memberId,
  };
}
