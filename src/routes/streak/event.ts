import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { recordEventSchema } from "../../schemas/streak.js";
import {
  emptyState,
  recordActivity,
  type StreakState,
} from "../../lib/streak.js";

/**
 * POST /streak/event — record one activity event for the caller.
 *
 * Loads the user's row (or fresh emptyState if none yet), runs the
 * pure-function streak computation, and upserts. Returns the new
 * state plus the derived flags the UI uses for celebration toasts.
 */
export default async function streakEventRoute(app: FastifyInstance) {
  app.post(
    "/event",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = recordEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const userId = request.currentUser!.userId;
      const row = await app.prisma.userStreak.findUnique({
        where: { userId },
      });
      const prev: StreakState = row
        ? {
            currentStreak: row.currentStreak,
            longestStreak: row.longestStreak,
            totalActiveDays: row.totalActiveDays,
            freezesAvailable: row.freezesAvailable,
            lastActiveDay: row.lastActiveDay
              ? row.lastActiveDay.toISOString().slice(0, 10)
              : null,
            todayActivities:
              (row.todayActivities as StreakState["todayActivities"]) ?? [],
            history: (row.history as StreakState["history"]) ?? {},
          }
        : emptyState();

      const result = recordActivity(prev, parsed.data, new Date());
      const s = result.state;

      // upsert keeps the route idempotent against the "user has no row
      // yet" case without a separate findOrCreate dance.
      const lastActiveDayDate = s.lastActiveDay
        ? new Date(s.lastActiveDay + "T00:00:00Z")
        : null;
      await app.prisma.userStreak.upsert({
        where: { userId },
        create: {
          userId,
          currentStreak: s.currentStreak,
          longestStreak: s.longestStreak,
          totalActiveDays: s.totalActiveDays,
          freezesAvailable: s.freezesAvailable,
          lastActiveDay: lastActiveDayDate,
          todayActivities: s.todayActivities,
          history: s.history,
        },
        update: {
          currentStreak: s.currentStreak,
          longestStreak: s.longestStreak,
          totalActiveDays: s.totalActiveDays,
          freezesAvailable: s.freezesAvailable,
          lastActiveDay: lastActiveDayDate,
          todayActivities: s.todayActivities,
          history: s.history,
        },
      });

      return reply.send({
        state: s,
        isFirstActivityToday: result.isFirstActivityToday,
        hitMilestone: result.hitMilestone,
        freezeConsumed: result.freezeConsumed,
      });
    },
  );
}
