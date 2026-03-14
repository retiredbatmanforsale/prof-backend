import type { FastifyInstance } from "fastify";
import { refreshSchema } from "../../schemas/auth.js";
import { hashToken } from "../../lib/tokens.js";
import { issueTokens, revokeRefreshToken } from "../../lib/session.js";

export default async function refreshRoute(app: FastifyInstance) {
  app.post(
    "/refresh",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const parsed = refreshSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { refreshToken: rawToken } = parsed.data;
      const hashedTokenValue = hashToken(rawToken);

      const tokenRecord = await app.prisma.refreshToken.findUnique({
        where: { token: hashedTokenValue },
        include: { user: true },
      });

      if (
        !tokenRecord ||
        tokenRecord.isRevoked ||
        tokenRecord.expiresAt < new Date()
      ) {
        // Token theft detection: if token was already revoked, revoke all user tokens
        if (tokenRecord && tokenRecord.isRevoked) {
          await app.prisma.refreshToken.updateMany({
            where: { userId: tokenRecord.userId },
            data: { isRevoked: true },
          });
        }

        return reply.status(401).send({ error: "Invalid refresh token" });
      }

      if (!tokenRecord.user.isActive) {
        return reply.status(403).send({ error: "Account deactivated" });
      }

      // Revoke old refresh token (rotation)
      await revokeRefreshToken(app.prisma, rawToken);

      // Issue new tokens
      const tokens = await issueTokens(app, tokenRecord.user, app.prisma);

      return reply.send({
        success: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    }
  );
}
