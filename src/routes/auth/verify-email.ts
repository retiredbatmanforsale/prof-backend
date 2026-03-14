import type { FastifyInstance } from "fastify";
import { hashToken } from "../../lib/tokens.js";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

export default async function verifyEmailRoute(app: FastifyInstance) {
  app.get("/verify-email", async (request, reply) => {
    const { token } = request.query as { token?: string };

    if (!token) {
      return reply.redirect(`${FRONTEND_URL}/login?error=invalid_token`);
    }

    const hashedTokenValue = hashToken(token);

    const tokenRecord = await app.prisma.emailVerificationToken.findUnique({
      where: { token: hashedTokenValue },
    });

    if (!tokenRecord) {
      return reply.redirect(`${FRONTEND_URL}/login?error=invalid_token`);
    }

    if (tokenRecord.expiresAt < new Date()) {
      await app.prisma.emailVerificationToken.delete({
        where: { id: tokenRecord.id },
      });
      return reply.redirect(`${FRONTEND_URL}/login?error=token_expired`);
    }

    await app.prisma.user.updateMany({
      where: { email: tokenRecord.email },
      data: { emailVerified: new Date() },
    });

    await app.prisma.emailVerificationToken.delete({
      where: { id: tokenRecord.id },
    });

    return reply.redirect(`${FRONTEND_URL}/login?verified=true`);
  });
}
