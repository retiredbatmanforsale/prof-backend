import type { FastifyInstance } from "fastify";
import { googleAuthSchema } from "../../schemas/auth.js";
import { verifyGoogleIdToken } from "../../lib/google.js";
import { issueTokens } from "../../lib/session.js";

export default async function googleAuthRoute(app: FastifyInstance) {
  app.post(
    "/google",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const parsed = googleAuthSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { credential } = parsed.data;

      let googleUser;
      try {
        googleUser = await verifyGoogleIdToken(credential);
      } catch (err) {
        app.log.error(err, "Google ID token verification failed");
        return reply.status(401).send({ error: "Invalid Google credential" });
      }

      // Find or create user
      let user = await app.prisma.user.findUnique({
        where: { email: googleUser.email.toLowerCase() },
      });

      if (user) {
        // Link Google account if not already linked
        await app.prisma.oAuthAccount.upsert({
          where: {
            provider_providerAccountId: {
              provider: "google",
              providerAccountId: googleUser.sub,
            },
          },
          create: {
            userId: user.id,
            provider: "google",
            providerAccountId: googleUser.sub,
          },
          update: {},
        });

        // Ensure email is verified for Google users
        if (!user.emailVerified) {
          await app.prisma.user.update({
            where: { id: user.id },
            data: { emailVerified: new Date() },
          });
        }
      } else {
        // Check if this email has a pending B2B invitation
        const pendingInvite = await app.prisma.preloadedStudent.findFirst({
          where: {
            email: googleUser.email.toLowerCase(),
            claimed: false,
            organization: { isActive: true },
          },
          include: { organization: { select: { name: true } } },
        });

        if (pendingInvite) {
          return reply.status(403).send({
            error:
              "Your institution has invited you. Please accept the invitation from your email.",
            code: "B2B_PENDING_INVITE",
            organizationName: pendingInvite.organization.name,
          });
        }

        // Create new user
        user = await app.prisma.user.create({
          data: {
            name: googleUser.name,
            email: googleUser.email.toLowerCase(),
            emailVerified: new Date(),
            image: googleUser.picture,
            oauthAccounts: {
              create: {
                provider: "google",
                providerAccountId: googleUser.sub,
              },
            },
          },
        });
      }

      if (!user.isActive) {
        return reply.status(403).send({ error: "Account is deactivated" });
      }

      // Check PreloadedStudent for B2B auto-access
      const preloaded = await app.prisma.preloadedStudent.findFirst({
        where: {
          email: user.email.toLowerCase(),
          claimed: false,
        },
        include: { organization: true },
      });

      if (preloaded && preloaded.organization.isActive) {
        // Auto-grant institutional access
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

      // Issue tokens
      const tokens = await issueTokens(app, user, app.prisma);

      return reply.send({
        success: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    }
  );
}
