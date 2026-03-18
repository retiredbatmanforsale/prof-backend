import type { FastifyRequest, FastifyReply } from "fastify";

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (request.currentUser?.role !== "ADMIN") {
    return reply.status(403).send({ error: "Admin access required" });
  }
}
