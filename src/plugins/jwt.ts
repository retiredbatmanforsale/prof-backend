import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance } from "fastify";

export default fp(async (fastify: FastifyInstance) => {
  fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET!,
    sign: {
      expiresIn: "15m",
    },
  });
});
