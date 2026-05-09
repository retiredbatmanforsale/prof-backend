import type { FastifyInstance } from "fastify";
import progressTrackRoute from "./track.js";
import progressSummaryRoute from "./summary.js";

export default async function progressRoutes(app: FastifyInstance) {
  await app.register(progressTrackRoute);
  await app.register(progressSummaryRoute);
}
