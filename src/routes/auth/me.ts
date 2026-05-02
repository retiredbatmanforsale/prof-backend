import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { getAccessInfo } from "../../lib/session.js";
import { updatePhoneSchema, updateProfileSchema } from "../../schemas/auth.js";

export default async function meRoute(app: FastifyInstance) {
  app.get(
    "/me",
    {
      preHandler: [authenticate],
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const user = await app.prisma.user.findUnique({
        where: { id: request.currentUser!.userId },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
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

  app.patch(
    "/me/phone",
    {
      preHandler: [authenticate],
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const parsed = updatePhoneSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const userId = request.currentUser!.userId;
      const { phone } = parsed.data;

      await app.prisma.user.update({
        where: { id: userId },
        data: { phone },
      });

      return reply.send({ success: true, phone });
    }
  );

  app.patch(
    "/me",
    {
      preHandler: [authenticate],
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const parsed = updateProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const userId = request.currentUser!.userId;
      const updates: { name?: string; phone?: string } = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.phone !== undefined) updates.phone = parsed.data.phone;

      const user = await app.prisma.user.update({
        where: { id: userId },
        data: updates,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          image: true,
          role: true,
          isPremium: true,
        },
      });

      return reply.send({ success: true, user });
    }
  );
}
