import type { FastifyInstance } from "fastify";
import { buildProgressSummary } from "../../lib/progressSummary.js";

/**
 * GET /progress/public/:userId — UNAUTHENTICATED public profile payload
 * powering the shareable page at /u/<userId>.
 *
 * Access model: link-as-capability. The userId is the user's existing
 * (unguessable) cuid; there is no handle and no opt-in flag, so the page
 * is unlisted and marked noindex on the frontend rather than gated by a
 * DB column. No schema changes.
 *
 * Exposes only a curated, non-sensitive subset of the progress summary:
 * no email/phone/subscription, no quiz "review targets" (weak spots), and
 * no per-course resume links. Cached for 60s to absorb viral traffic.
 */
export default async function progressPublicProfileRoute(app: FastifyInstance) {
  app.get<{ Params: { userId: string } }>(
    "/public/:userId",
    async (request, reply) => {
      const { userId } = request.params;

      // cuids are non-empty alphanumeric strings; reject obviously bad ids
      // before hitting the DB.
      if (!userId || !/^[a-z0-9]{10,}$/i.test(userId)) {
        return reply.code(404).send({ error: "Profile not found" });
      }

      const summary = await buildProgressSummary(app.prisma, userId);
      if (!summary) {
        return reply.code(404).send({ error: "Profile not found" });
      }

      reply.header("Cache-Control", "public, max-age=60");

      // Curated public subset — strip resume links and review targets.
      return reply.send({
        name: summary.name,
        image: summary.image,
        joinedAt: summary.joinedAt,
        totalLessonsRead: summary.totalLessonsRead,
        totalLessonsAvailable: summary.totalLessonsAvailable,
        coursesCompleted: summary.coursesCompleted,
        lastActiveAt: summary.lastActiveAt,
        currentStreak: summary.currentStreak,
        longestStreak: summary.longestStreak,
        totalActiveDays: summary.totalActiveDays,
        activeDaysLast30: summary.activeDaysLast30,
        heatmap: summary.heatmap,
        perCourse: summary.perCourse.map((c) => ({
          courseId: c.courseId,
          label: c.label,
          track: c.track,
          lessonsRead: c.lessonsRead,
          totalLessons: c.totalLessons,
        })),
        quizzes: {
          attempted: summary.quizzes.attempted,
          avgScore: summary.quizzes.avgScore,
          topScores: summary.quizzes.topScores,
        },
      });
    }
  );
}
