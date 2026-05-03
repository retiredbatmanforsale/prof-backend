import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

let initialized = false;

export function initSentry() {
  const DSN = process.env.SENTRY_DSN;
  if (!DSN || initialized) return;

  Sentry.init({
    dsn: DSN,
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV || "development",
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    profileSessionSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    profileLifecycle: "trace",
    sendDefaultPii: false,
  });

  initialized = true;
}

export { Sentry };
