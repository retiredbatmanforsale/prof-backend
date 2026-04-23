import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";

export default async function getQuizAttemptRoute(app: FastifyInstance) {
  app.get(
    "/attempts/:lessonId",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { lessonId } = request.params as { lessonId: string };
      const userId = request.currentUser!.userId;

      const attempt = await app.prisma.quizAttempt.findUnique({
        where: { userId_lessonId: { userId, lessonId } },
      });

      return reply.send({ attempt: attempt ?? null });
    }
  );
}
