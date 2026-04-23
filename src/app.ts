import Fastify from "fastify";
import helmetPlugin from "@fastify/helmet";
import corsPlugin from "./plugins/cors.js";
import jwtPlugin from "./plugins/jwt.js";
import prismaPlugin from "./plugins/prisma.js";
import rateLimitPlugin from "./plugins/rate-limit.js";
import multipartPlugin from "./plugins/multipart.js";
import authRoutes from "./routes/auth/index.js";
import adminRoutes from "./routes/admin/index.js";
import paymentRoutes from "./routes/payments/index.js";
import subscriptionRoutes from "./routes/subscriptions/index.js";
import razorpayWebhookRoute from "./routes/webhooks/razorpay.js";
import quizRoutes from "./routes/quiz/index.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "test" ? "warn" : "info",
    },
    trustProxy: true,
  });

  // Register plugins
  await app.register(helmetPlugin, {
    contentSecurityPolicy: false, // API doesn't serve HTML
  });
  await app.register(corsPlugin);
  await app.register(rateLimitPlugin);
  await app.register(jwtPlugin);
  await app.register(prismaPlugin);
  await app.register(multipartPlugin);

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

  // Email diagnostics — tests Gmail API connection
  app.get("/health/email", async (_request, reply) => {
    const { google } = await import("googleapis");
    const diagnostics: Record<string, any> = {
      NODE_ENV: process.env.NODE_ENV,
      EMAIL_FROM: process.env.EMAIL_FROM || "(not set)",
      FRONTEND_URL: process.env.FRONTEND_URL || "(not set)",
      BACKEND_URL: process.env.BACKEND_URL || "(not set)",
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? "set" : "MISSING",
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? "set" : "MISSING",
      GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN ? "set" : "MISSING",
    };

    try {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        "https://developers.google.com/oauthplayground"
      );
      oauth2Client.setCredentials({
        refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      });

      // Test token refresh
      const { token } = await oauth2Client.getAccessToken();
      diagnostics.accessToken = token ? "obtained" : "FAILED";

      // Test Gmail API access
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      const profile = await gmail.users.getProfile({ userId: "me" });
      diagnostics.gmailUser = profile.data.emailAddress;
      diagnostics.messagesTotal = profile.data.messagesTotal;
      diagnostics.status = "ok";
    } catch (err: any) {
      diagnostics.status = "error";
      diagnostics.error = err.message;
      diagnostics.errorCode = err.code || err.response?.status;
      diagnostics.errorDetails = err.errors || err.response?.data;
      return reply.status(500).send(diagnostics);
    }

    return reply.send(diagnostics);
  });

  // Register routes
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.register(paymentRoutes, { prefix: "/payments" });
  await app.register(subscriptionRoutes, { prefix: "/subscriptions" });
  await app.register(razorpayWebhookRoute, { prefix: "/webhooks" });
  await app.register(quizRoutes, { prefix: "/quiz" });

  return app;
}
