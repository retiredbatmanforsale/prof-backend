import Fastify from "fastify";
import corsPlugin from "./plugins/cors.js";
import jwtPlugin from "./plugins/jwt.js";
import prismaPlugin from "./plugins/prisma.js";
import rateLimitPlugin from "./plugins/rate-limit.js";
import authRoutes from "./routes/auth/index.js";
import paymentRoutes from "./routes/payments/index.js";
import subscriptionRoutes from "./routes/subscriptions/index.js";
import razorpayWebhookRoute from "./routes/webhooks/razorpay.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "test" ? "warn" : "info",
    },
    trustProxy: true,
  });

  // Register plugins
  await app.register(corsPlugin);
  await app.register(rateLimitPlugin);
  await app.register(jwtPlugin);
  await app.register(prismaPlugin);

  // Health check
  app.get("/health", async () => ({ status: "ok" }));

  // Readiness check
  app.get("/health/ready", async (_request, reply) => {
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      return { status: "ok", db: "ok" };
    } catch {
      return reply.status(503).send({ status: "error", db: "unreachable" });
    }
  });

  // Register routes
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(paymentRoutes, { prefix: "/payments" });
  await app.register(subscriptionRoutes, { prefix: "/subscriptions" });
  await app.register(razorpayWebhookRoute, { prefix: "/webhooks" });

  return app;
}
