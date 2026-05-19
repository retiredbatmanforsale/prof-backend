import type { FastifyInstance } from "fastify";
import streakStateRoute from "./state.js";
import streakEventRoute from "./event.js";

/**
 * Streak routes — server-of-record for the streak counter, freeze
 * balance, and the per-day activity heatmap. Lesson progress and
 * quiz attempts are tracked by their own routes (/progress, /quiz);
 * this surface is purely the "consecutive days" engagement loop.
 */
export default async function streakRoutes(app: FastifyInstance) {
  await app.register(streakStateRoute);
  await app.register(streakEventRoute);
}
