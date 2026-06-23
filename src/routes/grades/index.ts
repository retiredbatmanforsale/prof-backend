import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { getStudentGradebook } from "../../lib/gradebook.js";

/**
 * Student-facing gradebook (/grades). The caller sees ONLY their own cohort's
 * components and their own scores — same source of truth the faculty Grades tab
 * reads, so the numbers always match. Total % + letter grade are derived on the
 * client (lib/university/gradebook.ts).
 */
export default async function gradesRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [authenticate] }, async (request, reply) => {
    const userId = request.currentUser!.userId;
    const gradebook = await getStudentGradebook(app.prisma, userId);
    return reply.send(gradebook);
  });
}
