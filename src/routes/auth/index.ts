import type { FastifyInstance } from "fastify";
import googleAuthRoute from "./google.js";
import registerRoute from "./register.js";
import loginRoute from "./login.js";
import refreshRoute from "./refresh.js";
import logoutRoute from "./logout.js";
import meRoute from "./me.js";
import verifyEmailRoute from "./verify-email.js";
import forgotPasswordRoute from "./forgot-password.js";
import resetPasswordRoute from "./reset-password.js";

export default async function authRoutes(app: FastifyInstance) {
  await app.register(googleAuthRoute);
  await app.register(registerRoute);
  await app.register(loginRoute);
  await app.register(refreshRoute);
  await app.register(logoutRoute);
  await app.register(meRoute);
  await app.register(verifyEmailRoute);
  await app.register(forgotPasswordRoute);
  await app.register(resetPasswordRoute);
}
