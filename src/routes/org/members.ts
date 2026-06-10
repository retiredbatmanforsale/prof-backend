import type { FastifyInstance } from "fastify";

/**
 * GET /org/members — the caller's organization roster (active members), used by
 * the campus-admin sections UI to pick staff to assign or students to add to a
 * cohort. Org-scoped via requireOrgAdmin (parent), so it only ever returns the
 * caller's own org. Returns the orgRole so the UI can split staff vs students.
 */
export default async function orgMembersRoutes(app: FastifyInstance) {
  app.get(
    "/members",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const members = await app.prisma.organizationMember.findMany({
        where: { organizationId: ctx.organizationId, isActive: true },
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
