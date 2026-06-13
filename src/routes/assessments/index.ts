import type { FastifyInstance } from "fastify";
import {
  AssessmentStatus,
  AssessmentVisibility,
  AttemptPolicy,
  AttemptStatus,
  Prisma,
} from "@prisma/client";
import { authenticate } from "../../hooks/auth.js";
import { activeOrgWhere } from "../../lib/orgRole.js";
import { attemptStateSchema } from "../../schemas/assessment.js";
import {
  serializeAssessmentSummary,
  serializeQuestionForStudent,
} from "../../lib/assessments.js";

/**
 * Student-facing assessment surface (/assessments/*). Gated by `authenticate`.
 *
 * Visibility resolves by persona (the user's own org membership):
 *   • Independent (no active org membership) → PROF_GLOBAL assessments only.
 *   • Institutional (active org member)      → ORGANIZATION (their org) +
 *     SECTION (assigned to their cohorts).
 * PROF_GLOBAL is authored by Root Admin, ORGANIZATION by Campus Admin, SECTION
 * by Faculty/TA. Answer keys are stripped from every question here.
 */
export default async function studentAssessmentRoutes(app: FastifyInstance) {
  const rateLimit = { max: 60, timeWindow: "1 minute" } as const;

  type Scope =
    | { mode: "global" }
    | { mode: "institutional"; orgIds: string[]; sectionIds: string[] };

  async function resolveScope(userId: string): Promise<Scope> {
    const now = new Date();
    const memberships = await app.prisma.organizationMember.findMany({
      where: { userId, isActive: true, organization: activeOrgWhere(now) },
      select: { id: true, organizationId: true },
    });
    if (memberships.length === 0) return { mode: "global" };
    const memberIds = memberships.map((m) => m.id);
    const orgIds = [...new Set(memberships.map((m) => m.organizationId))];
    const ss = await app.prisma.sectionStudent.findMany({
      where: { organizationMemberId: { in: memberIds } },
      select: { sectionId: true },
    });
    const sectionIds = [...new Set(ss.map((s) => s.sectionId))];
    return { mode: "institutional", orgIds, sectionIds };
  }

  // Build the visibility `where` for a scope. PUBLISHED only.
  function visibilityWhere(scope: Scope): Prisma.AssessmentWhereInput {
    if (scope.mode === "global") {
      return { status: AssessmentStatus.PUBLISHED, visibility: AssessmentVisibility.PROF_GLOBAL };
    }
    return {
      status: AssessmentStatus.PUBLISHED,
      OR: [
        { visibility: AssessmentVisibility.ORGANIZATION, organizationId: { in: scope.orgIds } },
        {
          visibility: AssessmentVisibility.SECTION,
          assignments: { some: { sectionId: { in: scope.sectionIds } } },
        },
      ],
    };
  }

  // GET /assessments — visible assessments for the caller's persona.
  app.get("/", { preHandler: [authenticate], config: { rateLimit } }, async (request, reply) => {
    const scope = await resolveScope(request.currentUser!.userId);
    const assessments = await app.prisma.assessment.findMany({
      where: visibilityWhere(scope),
      orderBy: [{ dueAt: "asc" }, { updatedAt: "desc" }],
      include: { _count: { select: { questions: true, assignments: true } } },
    });
    return reply.send({
      mode: scope.mode,
      assessments: assessments.map(serializeAssessmentSummary),
    });
  });

  // GET /assessments/:id — detail, only if visible to the caller's persona.
  app.get<{ Params: { id: string } }>("/:id", { preHandler: [authenticate], config: { rateLimit } }, async (request, reply) => {
    const scope = await resolveScope(request.currentUser!.userId);
    const assessment = await app.prisma.assessment.findFirst({
      where: { id: request.params.id, ...visibilityWhere(scope) },
      include: { questions: { orderBy: { order: "asc" } } },
    });
    if (!assessment) return reply.status(404).send({ error: "Assessment not found" });

    return reply.send({
      assessment: {
        id: assessment.id,
        title: assessment.title,
        description: assessment.description,
        track: assessment.track,
        attemptPolicy: assessment.attemptPolicy,
        navigationMode: assessment.navigationMode,
        shuffleQuestions: assessment.shuffleQuestions,
        lateEntryAllowed: assessment.lateEntryAllowed,
        autoSubmit: assessment.autoSubmit,
        durationMinutes: assessment.durationMinutes,
        opensAt: assessment.opensAt?.toISOString() ?? null,
        dueAt: assessment.dueAt?.toISOString() ?? null,
        questions: assessment.questions.map(serializeQuestionForStudent),
      },
    });
  });

  // ─── Attempt persistence ────────────────────────────────────
  // No grading / execution — just durable storage of the student's work +
  // attempt-policy enforcement. State (answers / currentQuestion /
  // flaggedQuestions / draftCode) lives in AssessmentAttempt.answers (JSONB).

  // The assessment, only if visible to the caller, with its attempt policy.
  async function accessible(userId: string, id: string) {
    const scope = await resolveScope(userId);
    return app.prisma.assessment.findFirst({
      where: { id, ...visibilityWhere(scope) },
      select: { id: true, attemptPolicy: true },
    });
  }

  const emptyState = { answers: {}, currentQuestion: 0, flaggedQuestions: [], draftCode: {} };

  function serializeAttempt(a: {
    id: string;
    status: AttemptStatus;
    startedAt: Date;
    exitedAt: Date | null;
    remainingAttempts: number;
    answers: Prisma.JsonValue;
  }) {
    return {
      id: a.id,
      status: a.status,
      startedAt: a.startedAt.toISOString(),
      exitedAt: a.exitedAt?.toISOString() ?? null,
      remainingAttempts: a.remainingAttempts,
      state: (a.answers as object | null) ?? emptyState,
    };
  }

  // POST /assessments/:id/attempt/start — create or resume, policy-gated.
  app.post<{ Params: { id: string } }>(
    "/:id/attempt/start",
    { preHandler: [authenticate], config: { rateLimit } },
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const a = await accessible(userId, request.params.id);
      if (!a) return reply.status(404).send({ error: "Assessment not found" });

      const existing = await app.prisma.assessmentAttempt.findUnique({
        where: { assessmentId_userId: { assessmentId: a.id, userId } },
      });

      if (existing) {
        if (a.attemptPolicy === AttemptPolicy.SINGLE && existing.status === AttemptStatus.SUBMITTED) {
          return reply.status(403).send({ error: "You have already submitted this assessment.", locked: true });
        }
        if (
          a.attemptPolicy === AttemptPolicy.NONE &&
          existing.status !== AttemptStatus.IN_PROGRESS
        ) {
          return reply.status(403).send({ error: "This attempt is locked — no re-entry allowed.", locked: true });
        }
        // UNLIMITED (any state) or resumable SINGLE/NONE → resume in progress.
        const resumed = await app.prisma.assessmentAttempt.update({
          where: { id: existing.id },
          data: { status: AttemptStatus.IN_PROGRESS },
        });
        return reply.send({ attempt: serializeAttempt(resumed), attemptPolicy: a.attemptPolicy, resumed: true });
      }

      const created = await app.prisma.assessmentAttempt.create({
        data: {
          assessmentId: a.id,
          userId,
          status: AttemptStatus.IN_PROGRESS,
          remainingAttempts: a.attemptPolicy === AttemptPolicy.UNLIMITED ? 999 : 1,
          answers: emptyState as Prisma.InputJsonValue,
        },
      });
      return reply.status(201).send({ attempt: serializeAttempt(created), attemptPolicy: a.attemptPolicy, resumed: false });
    }
  );

  // PATCH /assessments/:id/attempt/save — autosave the full state.
  app.patch<{ Params: { id: string } }>(
    "/:id/attempt/save",
    { preHandler: [authenticate], config: { rateLimit: { max: 240, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const parsed = attemptStateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
      }
      const a = await accessible(userId, request.params.id);
      if (!a) return reply.status(404).send({ error: "Assessment not found" });

      const attempt = await app.prisma.assessmentAttempt.findUnique({
        where: { assessmentId_userId: { assessmentId: a.id, userId } },
        select: { id: true, status: true },
      });
      if (!attempt) return reply.status(404).send({ error: "No attempt — start first." });
      if (attempt.status !== AttemptStatus.IN_PROGRESS) {
        return reply.status(409).send({ error: "Attempt is not active.", status: attempt.status });
      }

      await app.prisma.assessmentAttempt.update({
        where: { id: attempt.id },
        data: { answers: { ...emptyState, ...parsed.data } as Prisma.InputJsonValue },
      });
      return reply.send({ success: true });
    }
  );

  // POST /assessments/:id/attempt/exit — leave; NONE policy locks it.
  app.post<{ Params: { id: string } }>(
    "/:id/attempt/exit",
    { preHandler: [authenticate], config: { rateLimit } },
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const a = await accessible(userId, request.params.id);
      if (!a) return reply.status(404).send({ error: "Assessment not found" });
      const attempt = await app.prisma.assessmentAttempt.findUnique({
        where: { assessmentId_userId: { assessmentId: a.id, userId } },
      });
      if (!attempt) return reply.status(404).send({ error: "No attempt to exit." });

      // Already-final attempts stay final.
      const newStatus =
        attempt.status === AttemptStatus.SUBMITTED
          ? AttemptStatus.SUBMITTED
          : a.attemptPolicy === AttemptPolicy.NONE
          ? AttemptStatus.LOCKED
          : AttemptStatus.EXITED;

      const parsed = attemptStateSchema.safeParse(request.body ?? {});
      const updated = await app.prisma.assessmentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: newStatus,
          exitedAt: new Date(),
          ...(parsed.success && Object.keys(parsed.data).length
            ? { answers: { ...emptyState, ...parsed.data } as Prisma.InputJsonValue }
            : {}),
        },
      });
      return reply.send({ attempt: serializeAttempt(updated), attemptPolicy: a.attemptPolicy });
    }
  );

  // POST /assessments/:id/attempt/submit — finalize (no grading).
  app.post<{ Params: { id: string } }>(
    "/:id/attempt/submit",
    { preHandler: [authenticate], config: { rateLimit } },
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const a = await accessible(userId, request.params.id);
      if (!a) return reply.status(404).send({ error: "Assessment not found" });
      const attempt = await app.prisma.assessmentAttempt.findUnique({
        where: { assessmentId_userId: { assessmentId: a.id, userId } },
      });
      if (!attempt) return reply.status(404).send({ error: "No attempt to submit." });

      const parsed = attemptStateSchema.safeParse(request.body ?? {});
      const updated = await app.prisma.assessmentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: AttemptStatus.SUBMITTED,
          exitedAt: new Date(),
          remainingAttempts: 0,
          ...(parsed.success && Object.keys(parsed.data).length
            ? { answers: { ...emptyState, ...parsed.data } as Prisma.InputJsonValue }
            : {}),
        },
      });
      return reply.send({ attempt: serializeAttempt(updated), attemptPolicy: a.attemptPolicy });
    }
  );

  // GET /assessments/:id/attempt — current attempt (or null) + policy.
  app.get<{ Params: { id: string } }>(
    "/:id/attempt",
    { preHandler: [authenticate], config: { rateLimit } },
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const a = await accessible(userId, request.params.id);
      if (!a) return reply.status(404).send({ error: "Assessment not found" });
      const attempt = await app.prisma.assessmentAttempt.findUnique({
        where: { assessmentId_userId: { assessmentId: a.id, userId } },
      });
      return reply.send({
        attempt: attempt ? serializeAttempt(attempt) : null,
        attemptPolicy: a.attemptPolicy,
      });
    }
  );
}
