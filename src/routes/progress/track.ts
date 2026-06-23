import type { FastifyInstance } from "fastify";
import {
  markProgressSchema,
  lessonStartSchema,
  lessonHeartbeatSchema,
  lessonCompleteSchema,
  MIN_COMPLETE_SECONDS,
  MIN_COMPLETE_SCROLL,
} from "../../schemas/progress.js";
import { authenticate } from "../../hooks/auth.js";
import { getStudentAssessmentParticipation } from "../../lib/lessonTracking.js";

export default async function progressTrackRoute(app: FastifyInstance) {
  // ─── Phase 4: attendance input — the caller's assessment participation ───
  // GET /progress/assessment-participation → { attempted, total } across the
  // caller's cohort's published assessments (presence only, no grading).
  app.get(
    "/assessment-participation",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const result = await getStudentAssessmentParticipation(app.prisma, userId);
      return reply.send(result);
    }
  );

  // ─── Phase 3: robust lesson tracking ───

  // POST /progress/start — student opened the lesson. Records startedAt once
  // and marks IN_PROGRESS, but never downgrades a lesson already completed.
  app.post(
    "/start",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = lessonStartSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const { lessonId } = parsed.data;
      const userId = request.currentUser!.userId;
      const now = new Date();

      const progress = await app.prisma.lessonProgress.upsert({
        where: { userId_lessonId: { userId, lessonId } },
        create: {
          userId,
          lessonId,
          status: "IN_PROGRESS",
          startedAt: now,
          lastActiveAt: now,
        },
        // Don't touch status (might already be READ) or startedAt (keep first
        // open). Just bump activity.
        update: { lastActiveAt: now },
      });

      return reply.send({ success: true, progress });
    }
  );

  // POST /progress/heartbeat — accumulate engagement while the lesson is open.
  // addSeconds is clamped by the schema (max 120); completionPercent only ever
  // climbs (deepest scroll reached). This is the meaningful-time + scroll
  // signal the completion gate checks.
  app.post(
    "/heartbeat",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = lessonHeartbeatSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const { lessonId, addSeconds, scrollPercent } = parsed.data;
      const userId = request.currentUser!.userId;
      const now = new Date();

      const existing = await app.prisma.lessonProgress.findUnique({
        where: { userId_lessonId: { userId, lessonId } },
        select: { completionPercent: true },
      });
      const nextScroll = Math.max(existing?.completionPercent ?? 0, scrollPercent);

      const progress = await app.prisma.lessonProgress.upsert({
        where: { userId_lessonId: { userId, lessonId } },
        create: {
          userId,
          lessonId,
          status: "IN_PROGRESS",
          startedAt: now,
          lastActiveAt: now,
          timeSpentSeconds: addSeconds,
          completionPercent: scrollPercent,
        },
        update: {
          lastActiveAt: now,
          timeSpentSeconds: { increment: addSeconds },
          completionPercent: nextScroll,
        },
        select: {
          lessonId: true,
          timeSpentSeconds: true,
          completionPercent: true,
          status: true,
          completedAt: true,
        },
      });

      const eligible =
        progress.timeSpentSeconds >= MIN_COMPLETE_SECONDS &&
        progress.completionPercent >= MIN_COMPLETE_SCROLL;

      return reply.send({ success: true, progress, eligibleToComplete: eligible });
    }
  );

  // POST /progress/complete — explicit "I'm done" click. Enforces the
  // engagement gate server-side: opening or skimming can never complete a
  // lesson. Returns 422 with what's still required when the gate isn't met.
  app.post(
    "/complete",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = lessonCompleteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const { lessonId } = parsed.data;
      const userId = request.currentUser!.userId;

      const existing = await app.prisma.lessonProgress.findUnique({
        where: { userId_lessonId: { userId, lessonId } },
        select: {
          timeSpentSeconds: true,
          completionPercent: true,
          completedAt: true,
          status: true,
        },
      });

      // Already completed — idempotent success.
      if (existing?.completedAt) {
        return reply.send({ success: true, alreadyComplete: true });
      }

      const timeSpent = existing?.timeSpentSeconds ?? 0;
      const scroll = existing?.completionPercent ?? 0;
      if (timeSpent < MIN_COMPLETE_SECONDS || scroll < MIN_COMPLETE_SCROLL) {
        return reply.status(422).send({
          error: "NOT_ELIGIBLE",
          message:
            "Spend a little more time and scroll through the lesson before completing it.",
          required: {
            minSeconds: MIN_COMPLETE_SECONDS,
            minScroll: MIN_COMPLETE_SCROLL,
          },
          current: { timeSpentSeconds: timeSpent, completionPercent: scroll },
        });
      }

      const now = new Date();
      const progress = await app.prisma.lessonProgress.update({
        where: { userId_lessonId: { userId, lessonId } },
        data: {
          status: "READ",
          completedAt: now,
          readAt: now,
          completionPercent: 100,
        },
      });

      return reply.send({ success: true, progress });
    }
  );

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
