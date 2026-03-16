import type { FastifyInstance } from "fastify";
import { forgotPasswordSchema } from "../../schemas/auth.js";
import { generateToken, hashToken } from "../../lib/tokens.js";
import { sendPasswordResetEmail, sendNoPasswordEmail } from "../../lib/email.js";

export default async function forgotPasswordRoute(app: FastifyInstance) {
  app.post(
    "/forgot-password",
    {
      config: {
        rateLimit: { max: 3, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const parsed = forgotPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const successResponse = {
        success: true,
        message:
          "If an account with that email exists, a password reset link has been sent.",
      };

      const user = await app.prisma.user.findUnique({
        where: { email: parsed.data.email.toLowerCase() },
      });

      if (!user) {
        return reply.send(successResponse);
      }

      if (!user.hashedPassword) {
        // User signed up via Google OAuth — no password to reset
        try {
          await sendNoPasswordEmail(user.email);
        } catch (err) {
          app.log.error(err, "Failed to send no-password email");
        }
        return reply.send(successResponse);
      }

      await app.prisma.passwordResetToken.updateMany({
        where: { userId: user.id, used: false },
        data: { used: true },
      });

      const rawToken = generateToken();
      const hashedTokenValue = hashToken(rawToken);

      await app.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          token: hashedTokenValue,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      try {
        await sendPasswordResetEmail(user.email, rawToken);
      } catch (err) {
        app.log.error(err, "Failed to send password reset email");
      }

      return reply.send(successResponse);
    }
  );
}
