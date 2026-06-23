import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { computeSectionLessonTracking } from "../../lib/lessonTracking.js";

/**
 * Student-facing class ranking (/ranking). The caller sees the leaderboard for
 * THEIR OWN cohort only — never another tenant's. Returns raw per-student
 * completion counts (lessons completed, labs solved, assessments attempted);
 * the client ranks by the chosen metric and computes percentages with the same
 * weighting engine the rest of the student dashboard uses, so numbers match.
 * Derived on read — nothing stored.
 */
export default async function rankingRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [authenticate] }, async (request, reply) => {
    const userId = request.currentUser!.userId;

    const membership = await app.prisma.sectionStudent.findFirst({
      where: { member: { userId } },
      select: { sectionId: true, section: { select: { name: true } } },
    });
    if (!membership) {
      return reply.send({ sectionName: null, assessmentsTotal: 0, you: userId, students: [] });
    }

    const tracking = await computeSectionLessonTracking(app.prisma, membership.sectionId);
    return reply.send({
      sectionName: membership.section.name,
      assessmentsTotal: tracking?.assessmentsTotal ?? 0,
      you: userId,
      students: (tracking?.students ?? []).map((s) => ({
        userId: s.userId,
        name: s.name,
        lessonsCompleted: s.completedCount,
        labsSolved: s.solvedCount,
        assessmentsAttempted: s.assessmentsAttempted,
      })),
    });
  });
}
