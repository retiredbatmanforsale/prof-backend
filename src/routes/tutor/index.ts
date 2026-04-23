import type { FastifyInstance } from "fastify";
import tutorChatRoute from "./chat.js";

export default async function tutorRoutes(app: FastifyInstance) {
  await app.register(tutorChatRoute);
}
