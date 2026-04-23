import type { FastifyInstance } from "fastify";
import submitQuizRoute from "./submit.js";
import getQuizAttemptRoute from "./get-attempt.js";

export default async function quizRoutes(app: FastifyInstance) {
  await app.register(submitQuizRoute);
  await app.register(getQuizAttemptRoute);
}
