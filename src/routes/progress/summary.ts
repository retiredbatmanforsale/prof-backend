import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { buildProgressSummary } from "../../lib/progressSummary.js";

/**
 * GET /progress/summary — single payload powering the user dashboard on
 * /account. LeetCode-style: one big number to push up + per-course bars +
 * 30-day activity heatmap.
 *
 * The metric computation lives in lib/progressSummary.ts so the public
 * shareable profile (/progress/public/:userId) shares the exact same math.
 */
export default async function progressSummaryRoute(app: FastifyInstance) {
  app.get(
    "/summary",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const summary = await buildProgressSummary(app.prisma, userId);

      if (!summary) {
        return reply.code(404).send({ error: "User not found" });
      }

      return reply.send(summary);
    }
  );
}
