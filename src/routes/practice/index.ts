import type { FastifyInstance } from "fastify";
import practiceTrackRoute from "./track.js";
import practiceCodeRoute from "./code.js";

export default async function practiceRoutes(app: FastifyInstance) {
  await app.register(practiceTrackRoute);
  await app.register(practiceCodeRoute);
}
