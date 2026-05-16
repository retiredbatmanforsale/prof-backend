import type { FastifyInstance } from "fastify";
import lessonLikesRoute from "./likes.js";

export default async function lessonRoutes(app: FastifyInstance) {
  await app.register(lessonLikesRoute);
}
