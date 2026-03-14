import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { getAccessInfo } from "../../lib/session.js";

export default async function meRoute(app: FastifyInstance) {
  app.get(
    "/me",
    {
      preHandler: [authenticate],
    },
    async (request, reply) => {
      const user = await app.prisma.user.findUnique({
        where: { id: request.currentUser!.userId },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
          isPremium: true,
          emailVerified: true,
          createdAt: true,
        },
      });

      if (!user) {
        return reply.status(404).send({ error: "User not found" });
      }

      const { hasAccess, accessType, organizationName } = await getAccessInfo(
        app.prisma,
        user.id
      );

      return reply.send({
        user,
        hasAccess,
        accessType,
        organizationName,
      });
    }
  );
}
