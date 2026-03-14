import type { FastifyInstance } from "fastify";
import { resetPasswordSchema } from "../../schemas/auth.js";
import { hashPassword } from "../../lib/passwords.js";
import { hashToken } from "../../lib/tokens.js";
import { revokeAllUserTokens } from "../../lib/session.js";

export default async function resetPasswordRoute(app: FastifyInstance) {
  app.post(
    "/reset-password",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const parsed = resetPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { token, password } = parsed.data;
      const hashedTokenValue = hashToken(token);

      const tokenRecord = await app.prisma.passwordResetToken.findUnique({
        where: { token: hashedTokenValue },
      });

      if (
        !tokenRecord ||
        tokenRecord.used ||
        tokenRecord.expiresAt < new Date()
      ) {
        return reply.status(400).send({
          error: "Invalid or expired reset token",
        });
      }

      const hashedPassword = await hashPassword(password);

      await app.prisma.user.update({
        where: { id: tokenRecord.userId },
        data: { hashedPassword },
      });

      await app.prisma.passwordResetToken.update({
        where: { id: tokenRecord.id },
        data: { used: true },
      });

      await revokeAllUserTokens(app.prisma, tokenRecord.userId);

      return reply.send({
        success: true,
        message:
          "Password has been reset. Please sign in with your new password.",
      });
    }
  );
}
