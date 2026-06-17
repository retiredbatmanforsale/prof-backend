import type { FastifyInstance } from "fastify";
import { FACULTY_TIER_ROLES } from "../../lib/orgRole.js";

/**
 * GET /org/members — the caller's organization roster (active members), used by
 * the campus-admin sections UI to pick staff to assign or students to add to a
 * cohort. Org-scoped via requireOrgAdmin (parent), so it only ever returns the
 * caller's own org. Returns the orgRole so the UI can split staff vs students.
 *
 * Optional `?role=staff` narrows the result to assignable teaching staff
 * (FACULTY / LAB_ASSISTANT / TA) — excluding campus admins and students. Omitting
 * the param preserves the original behavior (all active members), so existing
 * consumers are unaffected.
 */
export default async function orgMembersRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { role?: string } }>(
    "/members",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      // `?role=staff` → only teaching staff (assignable to a section). Any other
      // value (or none) returns the full active roster as before.
      const staffOnly = request.query.role === "staff";
      const members = await app.prisma.organizationMember.findMany({
        where: {
          organizationId: ctx.organizationId,
          isActive: true,
          ...(staffOnly ? { orgRole: { in: [...FACULTY_TIER_ROLES] } } : {}),
        },
        orderBy: { user: { name: "asc" } },
        select: {
          id: true,
          orgRole: true,
          user: { select: { id: true, name: true, email: true } },
        },
      });

      return reply.send({
        members: members.map((m) => ({
          memberId: m.id,
          orgRole: m.orgRole,
          ...m.user,
        })),
      });
    }
  );
}
