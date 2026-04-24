import type { FastifyInstance } from "fastify";
import progressTrackRoute from "./track.js";

export default async function progressRoutes(app: FastifyInstance) {
  await app.register(progressTrackRoute);
}
