import type { FastifyInstance } from "fastify";
import { registerSchema } from "../../schemas/auth.js";
import { hashPassword } from "../../lib/passwords.js";
import { generateToken, hashToken } from "../../lib/tokens.js";
import { sendVerificationEmail } from "../../lib/email.js";

export default async function registerRoute(app: FastifyInstance) {
  app.post(
    "/register",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { name, email, password } = parsed.data;

      const existing = await app.prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (existing) {
        return reply.status(409).send({
          error: "An account with this email already exists",
        });
      }

      const hashedPassword = await hashPassword(password);

      const user = await app.prisma.user.create({
        data: {
          name,
          email: email.toLowerCase(),
          hashedPassword,
        },
      });

      // Check PreloadedStudent for B2B auto-access
      const preloaded = await app.prisma.preloadedStudent.findFirst({
        where: {
          email: email.toLowerCase(),
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

      // Generate email verification token
      const rawToken = generateToken();
      const hashedTokenValue = hashToken(rawToken);

      await app.prisma.emailVerificationToken.create({
        data: {
          email: email.toLowerCase(),
          token: hashedTokenValue,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      try {
        await sendVerificationEmail(email, rawToken);
      } catch (err) {
        app.log.error(err, "Failed to send verification email");
      }

      return reply.status(201).send({
        success: true,
        message:
          "Account created. Please check your email to verify your account.",
      });
    }
  );
}
