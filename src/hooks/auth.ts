import type { FastifyRequest, FastifyReply } from "fastify";
import type { JWTPayload } from "../types/index.js";

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const payload = await request.jwtVerify<JWTPayload>();
    request.currentUser = payload;
  } catch {
    return reply.status(401).send({ error: "Unauthorized" });
  }
}

export async function optionalAuthenticate(
  request: FastifyRequest,
  _reply: FastifyReply
) {
  try {
    const payload = await request.jwtVerify<JWTPayload>();
    request.currentUser = payload;
  } catch {
    // Not authenticated — that's fine
  }
}
