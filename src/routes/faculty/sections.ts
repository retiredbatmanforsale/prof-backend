import type { FastifyInstance } from "fastify";
import { computeSectionMetrics } from "../../lib/orgMetrics.js";

/**
 * Faculty section routes under /faculty/*. Auth + faculty guard are applied at
 * the parent (faculty/index.ts), which resolves request.facultyContext. Every
 * query is scoped to the sections ASSIGNED to the caller (SectionAssignment) —
 * a faculty member never sees sections they don't teach.
 */
export default async function facultySectionsRoutes(app: FastifyInstance) {
  // GET /faculty/sections — only the sections assigned to the caller.
  app.get(
    "/sections",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const ctx = request.facultyContext!;
      const assignments = await app.prisma.sectionAssignment.findMany({
        where: { organizationMemberId: ctx.memberId },
        orderBy: { section: { name: "asc" } },
        select: {
          section: {
            select: {
              id: true,
              name: true,
              course: true,
              createdAt: true,
              _count: { select: { students: true } },
            },
          },
        },
      });

      return reply.send({
        sections: assignments.map(({ section: s }) => ({
          id: s.id,
          name: s.name,
          course: s.course,
          createdAt: s.createdAt.toISOString(),
          studentCount: s._count.students,
        })),
      });
    }
  );

  // GET /faculty/sections/:id/metrics — cohort metrics for one assigned
  // section. 403 if the section isn't assigned to the caller (so faculty can't
  // read a cohort they don't teach by guessing an id).
  app.get<{ Params: { id: string } }>(
    "/sections/:id/metrics",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const ctx = request.facultyContext!;
      const assignment = await app.prisma.sectionAssignment.findUnique({
        where: {
          sectionId_organizationMemberId: {
            sectionId: request.params.id,
            organizationMemberId: ctx.memberId,
          },
        },
        select: { sectionId: true },
      });
      if (!assignment) {
        return reply
          .status(403)
          .send({ error: "Not assigned to this section" });
      }

      const metrics = await computeSectionMetrics(app.prisma, assignment.sectionId);
      if (!metrics) {
        return reply.status(404).send({ error: "Section not found" });
      }
      return reply.send(metrics);
    }
  );
}
