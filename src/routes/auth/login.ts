import type { FastifyInstance } from "fastify";
import { loginSchema } from "../../schemas/auth.js";
import { verifyPassword } from "../../lib/passwords.js";
import { issueTokens } from "../../lib/session.js";

export default async function loginRoute(app: FastifyInstance) {
  app.post(
    "/login",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { email, password } = parsed.data;

      const user = await app.prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (!user || !user.hashedPassword) {
        // Check if this email is pre-approved for B2B but hasn't registered yet
        if (!user) {
          const preloaded = await app.prisma.preloadedStudent.findFirst({
            where: { email: email.toLowerCase(), claimed: false },
            include: { organization: { select: { isActive: true } } },
          });

          if (preloaded && preloaded.organization.isActive) {
            return reply.status(401).send({
              error: "Your institution has pre-approved your access. Create an account to get started.",
              code: "B2B_PREAPPROVED",
            });
          }
        }

        return reply.status(401).send({
          error: "Invalid email or password",
        });
      }

      if (!user.isActive) {
        return reply
          .status(403)
          .send({ error: "Account is deactivated" });
      }

      const valid = await verifyPassword(password, user.hashedPassword);
      if (!valid) {
        return reply
          .status(401)
          .send({ error: "Invalid email or password" });
      }

      if (!user.emailVerified) {
        return reply.status(403).send({
          error: "Please verify your email before signing in",
          code: "EMAIL_NOT_VERIFIED",
        });
      }

      // Check PreloadedStudent for B2B auto-access (in case they registered
      // before the org was set up, and are now logging in)
      const preloaded = await app.prisma.preloadedStudent.findFirst({
        where: {
          email: user.email.toLowerCase(),
          claimed: false,
        },
        include: { organization: true },
      });

      if (preloaded && preloaded.organization.isActive) {
        await app.prisma.$transaction([
          app.prisma.preloadedStudent.update({
            where: { id: preloaded.id },
            data: { claimed: true, claimedByUserId: user.id },
          }),
          app.prisma.organizationMember.upsert({
            where: {
              userId_organizationId: {
                userId: user.id,
                organizationId: preloaded.organizationId,
              },
            },
            create: {
              userId: user.id,
              organizationId: preloaded.organizationId,
              isVerified: true,
              isActive: true,
            },
            update: {
              isVerified: true,
              isActive: true,
            },
          }),
        ]);
      }

      const tokens = await issueTokens(app, user, app.prisma);

      return reply.send({
        success: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    }
  );
}
