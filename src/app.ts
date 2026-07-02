import Fastify, { type FastifyError } from "fastify";
import { Prisma } from "@prisma/client";
import helmetPlugin from "@fastify/helmet";
import { Sentry } from "./lib/sentry.js";
import corsPlugin from "./plugins/cors.js";
import jwtPlugin from "./plugins/jwt.js";
import prismaPlugin from "./plugins/prisma.js";
import rateLimitPlugin from "./plugins/rate-limit.js";
import multipartPlugin from "./plugins/multipart.js";
import authRoutes from "./routes/auth/index.js";
import adminRoutes from "./routes/admin/index.js";
import facultyRoutes from "./routes/faculty/index.js";
import paymentRoutes from "./routes/payments/index.js";
import subscriptionRoutes from "./routes/subscriptions/index.js";
import razorpayWebhookRoute from "./routes/webhooks/razorpay.js";
import quizRoutes from "./routes/quiz/index.js";
import tutorRoutes from "./routes/tutor/index.js";
import progressRoutes from "./routes/progress/index.js";
import practiceRoutes from "./routes/practice/index.js";
import gradesRoutes from "./routes/grades/index.js";
import studentAssessmentRoutes from "./routes/assessments/index.js";
import rankingRoutes from "./routes/ranking/index.js";
import lessonRoutes from "./routes/lessons/index.js";
import streakRoutes from "./routes/streak/index.js";

/**
 * Map a Prisma error to a SAFE, user-facing response. Returns null for
 * non-Prisma errors (handled by the default branch). The client never sees the
 * Prisma class name, SQL, column names, or `meta` — those are logged server-side.
 *
 * P2021 (table missing) / P2022 (column missing) are the schema-drift codes we
 * hit when code is deployed ahead of `prisma migrate deploy`; we surface them as
 * a transient 503 so users get a "retry / temporarily unavailable" message.
 */
function sanitizePrismaError(
  error: unknown
): { status: number; error: string; message: string } | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case "P2021": // table does not exist
      case "P2022": // column does not exist
      case "P2010": // raw query failed
        return { status: 503, error: "ServiceUnavailable", message: "This feature is temporarily unavailable. Please try again shortly." };
      case "P2002": // unique constraint
        return { status: 409, error: "Conflict", message: "This record already exists." };
      case "P2003": // foreign key constraint
        return { status: 409, error: "Conflict", message: "This action conflicts with related data." };
      case "P2025": // record not found
        return { status: 404, error: "NotFound", message: "The requested record was not found." };
      default:
        return { status: 503, error: "DatabaseError", message: "The database is temporarily unavailable. Please retry." };
    }
  }
  if (
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError
  ) {
    return { status: 503, error: "ServiceUnavailable", message: "The database is temporarily unavailable. Please retry." };
  }
  if (error instanceof Prisma.PrismaClientValidationError) {
    // A shape/type mismatch (often itself a symptom of schema drift). Do NOT
    // echo the validation text — it contains model/field internals.
    return { status: 400, error: "BadRequest", message: "The request could not be processed. Please contact an administrator if this persists." };
  }
  return null;
}

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

  // Sentry: capture every 5xx and unhandled error (no-op if SENTRY_DSN
  // unset — initSentry() guards init).
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (process.env.SENTRY_DSN) {
      Sentry.withScope((scope) => {
        scope.setTag("path", request.url);
        scope.setTag("method", request.method);
        if (request.user && typeof request.user === "object" && "id" in request.user) {
          scope.setUser({ id: String((request.user as { id: unknown }).id) });
        }
        Sentry.captureException(error);
      });
    }
    // Full internals (stack, prisma code/meta) go to the server log ONLY —
    // never to the client. `request.log.error(error)` serializes the stack.
    request.log.error(error);

    // Prisma failures must never surface their class name / SQL to end users
    // (e.g. "PrismaClientKnownRequestError"). Map them to safe messages and log
    // the code/meta server-side for on-call triage.
    const safe = sanitizePrismaError(error);
    if (safe) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        request.log.error(
          { event: "prisma_error", prismaCode: error.code, prismaMeta: error.meta, path: request.url, method: request.method },
          "prisma_known_request_error"
        );
      }
      return reply.status(safe.status).send({ error: safe.error, message: safe.message });
    }

    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      // Never leak internal error class names on 5xx.
      error: statusCode >= 500 ? "InternalServerError" : (error.name || "Error"),
      message: statusCode >= 500 ? "Internal server error" : error.message,
    });
  });

  // Register routes
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(adminRoutes, { prefix: "/admin" });
  // Phase 7: the former /org runtime surface is merged into /faculty.
  await app.register(facultyRoutes, { prefix: "/faculty" });
  await app.register(paymentRoutes, { prefix: "/payments" });
  await app.register(subscriptionRoutes, { prefix: "/subscriptions" });
  await app.register(razorpayWebhookRoute, { prefix: "/webhooks" });
  await app.register(quizRoutes, { prefix: "/quiz" });
  await app.register(tutorRoutes, { prefix: "/tutor" });
  await app.register(progressRoutes, { prefix: "/progress" });
  await app.register(practiceRoutes, { prefix: "/practice" });
  await app.register(gradesRoutes, { prefix: "/grades" });
  await app.register(studentAssessmentRoutes, { prefix: "/assessments" });
  await app.register(rankingRoutes, { prefix: "/ranking" });
  await app.register(lessonRoutes, { prefix: "/lessons" });
  await app.register(streakRoutes, { prefix: "/streak" });

  return app;
}
