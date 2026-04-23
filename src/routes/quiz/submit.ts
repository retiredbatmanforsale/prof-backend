import type { FastifyInstance } from "fastify";
import { submitQuizSchema } from "../../schemas/quiz.js";
import { authenticate } from "../../hooks/auth.js";

export default async function submitQuizRoute(app: FastifyInstance) {
  app.post(
    "/attempts",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = submitQuizSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { lessonId, score, total, answers } = parsed.data;
      const userId = request.currentUser!.userId;

      const attempt = await app.prisma.quizAttempt.upsert({
        where: { userId_lessonId: { userId, lessonId } },
        create: { userId, lessonId, score, total, answers },
        update: { score, total, answers },
      });

      return reply.send({ success: true, attempt });
    }
  );
}
