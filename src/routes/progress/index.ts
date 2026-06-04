import type { FastifyInstance } from "fastify";
import progressTrackRoute from "./track.js";
import progressSummaryRoute from "./summary.js";
import progressPublicProfileRoute from "./public-profile.js";

export default async function progressRoutes(app: FastifyInstance) {
  await app.register(progressTrackRoute);
  await app.register(progressSummaryRoute);
  await app.register(progressPublicProfileRoute);
}
