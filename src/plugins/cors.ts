import fp from "fastify-plugin";
import fastifyCors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

export default fp(async (fastify: FastifyInstance) => {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
    .split(",")
    .map((o) => o.trim());

  fastify.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (process.env.NODE_ENV === "development") {
        if (origin.match(/^https?:\/\/localhost(:\d+)?$/)) return cb(null, true);
      }
      cb(new Error("CORS not allowed"), false);
    },
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
});
