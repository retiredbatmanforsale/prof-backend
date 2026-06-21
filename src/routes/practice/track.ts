import type { FastifyInstance } from "fastify";
import {
  practiceAttemptSchema,
  practiceSolveSchema,
} from "../../schemas/practice.js";
import { authenticate } from "../../hooks/auth.js";

/**
 * Phase 3 practice tracking (/practice/*). The in-browser coding solver calls
 * these automatically — /attempt when the student runs their code and /solve
 * when every test passes. State is a thin per-(user, problem) record; there is
 * no submission history. solved is sticky (a later failed run never un-solves).
 */
export default async function practiceTrackRoute(app: FastifyInstance) {
  // POST /practice/attempt — student ran the problem at least once.
  app.post(
    "/attempt",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = practiceAttemptSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const { problemSlug } = parsed.data;
      const userId = request.currentUser!.userId;

      const attempt = await app.prisma.practiceAttempt.upsert({
        where: { userId_problemSlug: { userId, problemSlug } },
        create: { userId, problemSlug, attempts: 1 },
        update: { attempts: { increment: 1 } },
        select: { problemSlug: true, attempts: true, solved: true, solvedAt: true },
      });

      return reply.send({ success: true, attempt });
    }
  );

  // POST /practice/solve — all hidden tests passed. Sets solved (sticky) and
  // counts the run as an attempt.
  app.post(
    "/solve",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = practiceSolveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const { problemSlug } = parsed.data;
      const userId = request.currentUser!.userId;
      const now = new Date();

      const attempt = await app.prisma.practiceAttempt.upsert({
        where: { userId_problemSlug: { userId, problemSlug } },
        create: {
          userId,
          problemSlug,
          attempts: 1,
          solved: true,
          solvedAt: now,
        },
        update: {
          attempts: { increment: 1 },
          solved: true,
          // Keep the first solve time — don't overwrite on re-solves.
          solvedAt: undefined,
        },
      });

      // upsert's update can't conditionally set solvedAt only-when-null, so
      // backfill it here if this is the first solve.
      if (!attempt.solvedAt) {
        await app.prisma.practiceAttempt.update({
          where: { userId_problemSlug: { userId, problemSlug } },
          data: { solvedAt: now },
        });
      }

      return reply.send({
        success: true,
        attempt: {
          problemSlug: attempt.problemSlug,
          attempts: attempt.attempts,
          solved: true,
          solvedAt: attempt.solvedAt ?? now,
        },
      });
    }
  );

  // GET /practice/mine — the caller's practice state, for the roadmap/overview
  // to mark solved labs and compute weighted progress.
  app.get(
    "/mine",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const attempts = await app.prisma.practiceAttempt.findMany({
        where: { userId },
        select: { problemSlug: true, attempts: true, solved: true, solvedAt: true },
      });
      return reply.send({ attempts });
    }
  );
}
