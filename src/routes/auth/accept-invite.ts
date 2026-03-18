import type { FastifyInstance } from "fastify";
import { acceptInviteSchema } from "../../schemas/admin.js";
import { hashPassword } from "../../lib/passwords.js";

export default async function acceptInviteRoute(app: FastifyInstance) {
  // GET /auth/invite-info?token=xxx — Validate token and return info for form
  app.get(
    "/invite-info",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { token } = request.query as { token?: string };

      if (!token) {
        return reply.status(400).send({ error: "Token is required" });
      }

      const invitation = await app.prisma.invitationToken.findUnique({
        where: { token },
        include: {
          preloadedStudent: {
            include: {
              organization: { select: { name: true } },
            },
          },
        },
      });

      if (!invitation) {
        return reply.status(404).send({ error: "Invalid invitation link" });
      }

      if (invitation.used) {
        return reply.status(410).send({ error: "This invitation has already been used" });
      }

      if (invitation.expiresAt < new Date()) {
        return reply.status(410).send({ error: "This invitation has expired" });
      }

      return reply.send({
        email: invitation.preloadedStudent.email,
        name: invitation.preloadedStudent.name,
        organizationName: invitation.preloadedStudent.organization.name,
      });
    }
  );

  // POST /auth/accept-invite — Create account from invitation
  app.post(
    "/accept-invite",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = acceptInviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { token, name, password } = parsed.data;

      const invitation = await app.prisma.invitationToken.findUnique({
        where: { token },
        include: {
          preloadedStudent: {
            include: { organization: true },
          },
        },
      });

      if (!invitation) {
        return reply.status(404).send({ error: "Invalid invitation link" });
      }

      if (invitation.used) {
        return reply.status(410).send({ error: "This invitation has already been used" });
      }

      if (invitation.expiresAt < new Date()) {
        return reply.status(410).send({ error: "This invitation has expired" });
      }

      const { preloadedStudent } = invitation;
      const hashedPw = await hashPassword(password);

      // Check if user already exists
      const existingUser = await app.prisma.user.findUnique({
        where: { email: preloadedStudent.email },
      });

      if (existingUser) {
        // Update existing user and grant membership
        await app.prisma.$transaction([
          app.prisma.user.update({
            where: { id: existingUser.id },
            data: {
              name,
              hashedPassword: hashedPw,
              emailVerified: existingUser.emailVerified || new Date(),
            },
          }),
          app.prisma.organizationMember.upsert({
            where: {
              userId_organizationId: {
                userId: existingUser.id,
                organizationId: preloadedStudent.organizationId,
              },
            },
            create: {
              userId: existingUser.id,
              organizationId: preloadedStudent.organizationId,
              isVerified: true,
              isActive: true,
            },
            update: {
              isVerified: true,
              isActive: true,
            },
          }),
          app.prisma.preloadedStudent.update({
            where: { id: preloadedStudent.id },
            data: { claimed: true, claimedByUserId: existingUser.id },
          }),
          app.prisma.invitationToken.update({
            where: { id: invitation.id },
            data: { used: true },
          }),
        ]);
      } else {
        // Create new user + membership in a transaction
        await app.prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              name,
              email: preloadedStudent.email,
              hashedPassword: hashedPw,
              emailVerified: new Date(),
              role: "USER",
            },
          });

          await tx.organizationMember.create({
            data: {
              userId: user.id,
              organizationId: preloadedStudent.organizationId,
              isVerified: true,
              isActive: true,
            },
          });

          await tx.preloadedStudent.update({
            where: { id: preloadedStudent.id },
            data: { claimed: true, claimedByUserId: user.id },
          });

          await tx.invitationToken.update({
            where: { id: invitation.id },
            data: { used: true },
          });
        });
      }

      return reply.send({ success: true });
    }
  );
}
