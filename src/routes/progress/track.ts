import type { FastifyInstance } from "fastify";
import { markProgressSchema } from "../../schemas/progress.js";
import { authenticate } from "../../hooks/auth.js";

export default async function progressTrackRoute(app: FastifyInstance) {
  // POST /progress/read — mark a lesson as READ
  app.post(
    "/read",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = markProgressSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { lessonId } = parsed.data;
      const userId = request.currentUser!.userId;

      const progress = await app.prisma.lessonProgress.upsert({
        where: { userId_lessonId: { userId, lessonId } },
        create: {
          userId,
          lessonId,
          status: "READ",
          readAt: new Date(),
        },
        update: {
          status: "READ",
          readAt: new Date(),
        },
      });

      return reply.send({ success: true, progress });
    }
  );

  // POST /progress/in-progress — mark a lesson as IN_PROGRESS (page opened)
  app.post(
    "/in-progress",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = markProgressSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { lessonId } = parsed.data;
      const userId = request.currentUser!.userId;

      // Only create if no record exists — never downgrade READ → IN_PROGRESS
      const existing = await app.prisma.lessonProgress.findUnique({
        where: { userId_lessonId: { userId, lessonId } },
      });

      if (!existing) {
        await app.prisma.lessonProgress.create({
          data: { userId, lessonId, status: "IN_PROGRESS" },
        });
      }

      return reply.send({ success: true });
    }
  );

  // GET /progress/course/:courseId — fetch all progress for a course
  app.get(
    "/course/:courseId",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { courseId } = request.params as { courseId: string };
      const userId = request.currentUser!.userId;

      const records = await app.prisma.lessonProgress.findMany({
        where: {
          userId,
          lessonId: { startsWith: courseId },
        },
        select: {
          lessonId: true,
          status: true,
          readAt: true,
        },
      });

      return reply.send({ progress: records });
    }
  );
}
