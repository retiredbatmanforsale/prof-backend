import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { emptyState, type StreakState } from "../../lib/streak.js";

/**
 * GET /streak — return the caller's current streak state.
 *
 * If the user has no row yet (first visit / no activity ever) we
 * return an empty-state shape without creating a DB row. The row is
 * created lazily on the first POST /streak/event call. This keeps
 * the read path cheap and means a casual page-load never costs a
 * DB write for an inactive user.
 */
export default async function streakStateRoute(app: FastifyInstance) {
  app.get(
    "/",
    { preHandler: [authenticate] },
    async (request, _reply) => {
      const userId = request.currentUser!.userId;
      const row = await app.prisma.userStreak.findUnique({
        where: { userId },
      });
      if (!row) {
        return { state: emptyState() };
      }
      const state: StreakState = {
        currentStreak: row.currentStreak,
        longestStreak: row.longestStreak,
        totalActiveDays: row.totalActiveDays,
        freezesAvailable: row.freezesAvailable,
        lastActiveDay: row.lastActiveDay
          ? row.lastActiveDay.toISOString().slice(0, 10)
          : null,
        // Prisma JSON columns come back as `unknown`; the cast is safe
        // because writes are gated by the schema below and recordActivity
        // only writes the right shape.
        todayActivities: (row.todayActivities as StreakState["todayActivities"]) ?? [],
        history: (row.history as StreakState["history"]) ?? {},
      };
      return { state };
    },
  );
}
