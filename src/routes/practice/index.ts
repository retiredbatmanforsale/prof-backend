import type { FastifyInstance } from "fastify";
import practiceTrackRoute from "./track.js";

export default async function practiceRoutes(app: FastifyInstance) {
  await app.register(practiceTrackRoute);
}
