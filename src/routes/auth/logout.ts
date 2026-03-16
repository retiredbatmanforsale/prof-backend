import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { logoutSchema } from "../../schemas/auth.js";
import { revokeRefreshToken, revokeAllUserTokens } from "../../lib/session.js";

export default async function logoutRoute(app: FastifyInstance) {
  app.post(
    "/logout",
    {
      preHandler: [authenticate],
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const parsed = logoutSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      await revokeRefreshToken(app.prisma, parsed.data.refreshToken);

      return reply.send({ success: true });
    }
  );

  app.post(
    "/logout-all",
    {
      preHandler: [authenticate],
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      await revokeAllUserTokens(app.prisma, request.currentUser!.userId);
      return reply.send({ success: true });
    }
  );
}
