import type { FastifyInstance } from "fastify";
import { AssessmentStatus, AssessmentVisibility, AttemptStatus } from "@prisma/client";
import type { AssessmentAttempt } from "@prisma/client";
import { authenticate } from "../../hooks/auth.js";
import { attemptStateSchema } from "../../schemas/assessment.js";
import { serializeQuestionForStudent } from "../../lib/assessments.js";
import { autoGrade, writeAutoGradeEntries } from "../../lib/grading.js";

/**
 * Student-facing assessment engine (/assessments). A student sees PUBLISHED
 * assessments visible to them (their section, their org, or PROF_GLOBAL), can
 * run a single attempt (start → save → submit), and view their result. Objective
 * questions auto-grade on submit; subjective/coding wait for faculty review.
 */
export default async function studentAssessmentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // Resolve the caller's org + section scope (as a learner).
  async function studentScope(userId: string) {
    const memberships = await app.prisma.organizationMember.findMany({
      where: { userId, isActive: true },
      select: {
        organizationId: true,
        sectionStudentOf: { select: { sectionId: true } },
      },
    });
    const orgIds = memberships.map((m) => m.organizationId);
    const sectionIds = memberships.flatMap((m) =>
      m.sectionStudentOf.map((s) => s.sectionId)
    );
    return { orgIds, sectionIds };
  }

  // The where-clause for assessments a given student may see.
  function visibleWhere(scope: { orgIds: string[]; sectionIds: string[] }) {
    return {
      status: AssessmentStatus.PUBLISHED,
      OR: [
        { visibility: AssessmentVisibility.SECTION, sectionId: { in: scope.sectionIds } },
        { visibility: AssessmentVisibility.ORGANIZATION, organizationId: { in: scope.orgIds } },
        { visibility: AssessmentVisibility.PROF_GLOBAL },
      ],
    };
  }

  type State = {
    answers: Record<string, unknown>;
    currentQuestion: number;
    flaggedQuestions: string[];
    draftCode: Record<string, string>;
  };
  function readState(attempt: AssessmentAttempt): State {
    const a = (attempt.answers ?? {}) as Partial<State>;
    return {
      answers: a.answers ?? {},
      currentQuestion: a.currentQuestion ?? 0,
      flaggedQuestions: a.flaggedQuestions ?? [],
      draftCode: a.draftCode ?? {},
    };
  }
  function toAttempt(attempt: AssessmentAttempt) {
    return {
      id: attempt.id,
      status: attempt.status,
      startedAt: attempt.startedAt.toISOString(),
      exitedAt: attempt.exitedAt?.toISOString() ?? null,
      remainingAttempts: attempt.remainingAttempts,
      state: readState(attempt),
      score: attempt.score ?? null,
      maxScore: attempt.maxScore ?? null,
      pendingReview: attempt.pendingReview,
      submittedAt: attempt.submittedAt?.toISOString() ?? null,
      gradedAt: attempt.gradedAt?.toISOString() ?? null,
    };
  }

  // Load an assessment + verify it's visible to this student. Returns null if not.
  async function loadVisible(userId: string, assessmentId: string) {
    const scope = await studentScope(userId);
    const assessment = await app.prisma.assessment.findFirst({
      where: { id: assessmentId, ...visibleWhere(scope) },
      include: { questions: { orderBy: { order: "asc" } } },
    });
    return assessment;
  }

  // GET /assessments — list visible assessments + this student's attempt state.
  app.get("/", async (request, reply) => {
    const userId = request.currentUser!.userId;
    const scope = await studentScope(userId);
    const rows = await app.prisma.assessment.findMany({
      where: visibleWhere(scope),
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { questions: true } },
        attempts: { where: { userId }, select: { status: true, score: true, maxScore: true, pendingReview: true } },
      },
    });
    const assessments = rows.map((a) => {
      const att = a.attempts[0];
      return {
        id: a.id,
        title: a.title,
        description: a.description,
        status: a.status,
        durationMinutes: a.durationMinutes,
        opensAt: a.opensAt?.toISOString() ?? null,
        dueAt: a.dueAt?.toISOString() ?? null,
        questionCount: a._count.questions,
        cohortCount: 0,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        track: a.track,
        attemptPolicy: a.attemptPolicy,
        visibility: a.visibility,
        attemptStatus: att?.status ?? null,
        score: att?.score ?? null,
        maxScore: att?.maxScore ?? null,
        pendingReview: att?.pendingReview ?? false,
      };
    });
    return reply.send({ assessments, mode: "institutional" });
  });

  // GET /assessments/:id — detail (answer keys stripped).
  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const userId = request.currentUser!.userId;
    const a = await loadVisible(userId, request.params.id);
    if (!a) return reply.status(404).send({ error: "Assessment not found" });
    return reply.send({
      assessment: {
        id: a.id,
        title: a.title,
        description: a.description,
        durationMinutes: a.durationMinutes,
        opensAt: a.opensAt?.toISOString() ?? null,
        dueAt: a.dueAt?.toISOString() ?? null,
        attemptPolicy: a.attemptPolicy,
        questions: a.questions.map(serializeQuestionForStudent),
      },
    });
  });

  // GET /assessments/:id/attempt — the student's current attempt (or null).
  app.get<{ Params: { id: string } }>("/:id/attempt", async (request, reply) => {
    const userId = request.currentUser!.userId;
    const a = await loadVisible(userId, request.params.id);
    if (!a) return reply.status(404).send({ error: "Assessment not found" });
    const attempt = await app.prisma.assessmentAttempt.findUnique({
      where: { assessmentId_userId: { assessmentId: a.id, userId } },
    });
    return reply.send({
      attempt: attempt ? toAttempt(attempt) : null,
      attemptPolicy: a.attemptPolicy,
    });
  });

  // POST /assessments/:id/attempt/start — create or resume.
  app.post<{ Params: { id: string } }>("/:id/attempt/start", async (request, reply) => {
    const userId = request.currentUser!.userId;
    const a = await loadVisible(userId, request.params.id);
    if (!a) return reply.status(404).send({ error: "Assessment not found" });

    const existing = await app.prisma.assessmentAttempt.findUnique({
      where: { assessmentId_userId: { assessmentId: a.id, userId } },
    });

    if (existing) {
      const finished = existing.status === "SUBMITTED" || existing.status === "LOCKED";
      if (finished && a.attemptPolicy === "UNLIMITED") {
        // Retake — reset to a fresh attempt.
        const reset = await app.prisma.assessmentAttempt.update({
          where: { id: existing.id },
          data: {
            status: AttemptStatus.IN_PROGRESS,
            answers: {},
            score: null,
            maxScore: null,
            submittedAt: null,
            gradedAt: null,
            pendingReview: false,
            reviewMarks: undefined,
            exitedAt: null,
            startedAt: new Date(),
          },
        });
        return reply.send({ attempt: toAttempt(reset), attemptPolicy: a.attemptPolicy, resumed: false });
      }
      if (!finished && existing.status === "EXITED") {
        const resumed = await app.prisma.assessmentAttempt.update({
          where: { id: existing.id },
          data: { status: AttemptStatus.IN_PROGRESS },
        });
        return reply.send({ attempt: toAttempt(resumed), attemptPolicy: a.attemptPolicy, resumed: true });
      }
      // IN_PROGRESS, or a finished single-attempt — return as-is.
      return reply.send({ attempt: toAttempt(existing), attemptPolicy: a.attemptPolicy, resumed: true });
    }

    const created = await app.prisma.assessmentAttempt.create({
      data: { assessmentId: a.id, userId, status: AttemptStatus.IN_PROGRESS, answers: {} },
    });
    return reply.send({ attempt: toAttempt(created), attemptPolicy: a.attemptPolicy, resumed: false });
  });

  // Merge a partial state patch onto the stored state.
  function mergeState(attempt: AssessmentAttempt, patch: Record<string, unknown>): State {
    const cur = readState(attempt);
    return {
      answers: (patch.answers as Record<string, unknown>) ?? cur.answers,
      currentQuestion: (patch.currentQuestion as number) ?? cur.currentQuestion,
      flaggedQuestions: (patch.flaggedQuestions as string[]) ?? cur.flaggedQuestions,
      draftCode: (patch.draftCode as Record<string, string>) ?? cur.draftCode,
    };
  }

  async function getOwnAttempt(userId: string, assessmentId: string) {
    return app.prisma.assessmentAttempt.findUnique({
      where: { assessmentId_userId: { assessmentId, userId } },
    });
  }

  // PATCH /assessments/:id/attempt/save — persist in-progress work.
  app.patch<{ Params: { id: string } }>("/:id/attempt/save", async (request, reply) => {
    const userId = request.currentUser!.userId;
    const parsed = attemptStateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    }
    const attempt = await getOwnAttempt(userId, request.params.id);
    if (!attempt) return reply.status(404).send({ error: "No attempt to save" });
    if (attempt.status === "SUBMITTED" || attempt.status === "LOCKED") {
      return reply.status(409).send({ error: "Attempt already submitted" });
    }
    await app.prisma.assessmentAttempt.update({
      where: { id: attempt.id },
      data: { answers: mergeState(attempt, parsed.data) as object },
    });
    return reply.send({ success: true });
  });

  // POST /assessments/:id/attempt/exit — leave without submitting.
  app.post<{ Params: { id: string } }>("/:id/attempt/exit", async (request, reply) => {
    const userId = request.currentUser!.userId;
    const parsed = attemptStateSchema.safeParse(request.body ?? {});
    const attempt = await getOwnAttempt(userId, request.params.id);
    if (!attempt) return reply.status(404).send({ error: "No attempt" });
    if (attempt.status === "SUBMITTED" || attempt.status === "LOCKED") {
      const a = await loadVisible(userId, request.params.id);
      return reply.send({ attempt: toAttempt(attempt), attemptPolicy: a?.attemptPolicy ?? "UNLIMITED" });
    }
    const updated = await app.prisma.assessmentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: AttemptStatus.EXITED,
        exitedAt: new Date(),
        answers: parsed.success ? (mergeState(attempt, parsed.data) as object) : attempt.answers ?? {},
      },
    });
    const a = await loadVisible(userId, request.params.id);
    return reply.send({ attempt: toAttempt(updated), attemptPolicy: a?.attemptPolicy ?? "UNLIMITED" });
  });

  // POST /assessments/:id/attempt/submit — finalize + auto-grade objective part.
  app.post<{ Params: { id: string } }>("/:id/attempt/submit", async (request, reply) => {
    const userId = request.currentUser!.userId;
    const a = await loadVisible(userId, request.params.id);
    if (!a) return reply.status(404).send({ error: "Assessment not found" });
    const attempt = await getOwnAttempt(userId, a.id);
    if (!attempt) return reply.status(404).send({ error: "No attempt to submit" });
    if (attempt.status === "SUBMITTED" || attempt.status === "LOCKED") {
      return reply.status(409).send({ error: "Attempt already submitted" });
    }

    const parsed = attemptStateSchema.safeParse(request.body ?? {});
    const state = parsed.success ? mergeState(attempt, parsed.data) : readState(attempt);

    const graded = autoGrade(a.questions, state.answers);
    const fullyAuto = graded.pendingQuestionIds.length === 0;
    const now = new Date();

    const updated = await app.prisma.assessmentAttempt.update({
      where: { id: attempt.id },
      data: {
        answers: state as object,
        status: AttemptStatus.SUBMITTED,
        submittedAt: now,
        score: graded.autoScore,
        maxScore: graded.maxScore,
        pendingReview: !fullyAuto,
        gradedAt: fullyAuto ? now : null,
      },
    });

    // Fully objective → grade flows straight into any AUTO gradebook component.
    if (fullyAuto) {
      await writeAutoGradeEntries(app.prisma, a.id, userId, graded.autoScore, graded.maxScore);
    }

    return reply.send({ attempt: toAttempt(updated), attemptPolicy: a.attemptPolicy });
  });

  // GET /assessments/:id/result — the student's own result (no answer keys).
  app.get<{ Params: { id: string } }>("/:id/result", async (request, reply) => {
    const userId = request.currentUser!.userId;
    const a = await loadVisible(userId, request.params.id);
    if (!a) return reply.status(404).send({ error: "Assessment not found" });
    const attempt = await getOwnAttempt(userId, a.id);
    if (!attempt || attempt.status !== "SUBMITTED") {
      return reply.status(404).send({ error: "No submitted attempt" });
    }
    const state = readState(attempt);
    const graded = autoGrade(a.questions, state.answers);
    const reviewMarks = (attempt.reviewMarks ?? {}) as Record<string, number>;

    return reply.send({
      title: a.title,
      status: attempt.status,
      score: attempt.score ?? graded.autoScore,
      maxScore: attempt.maxScore ?? graded.maxScore,
      pendingReview: attempt.pendingReview,
      submittedAt: attempt.submittedAt?.toISOString() ?? null,
      gradedAt: attempt.gradedAt?.toISOString() ?? null,
      questions: a.questions.map((q) => {
        const pq = graded.perQuestion.find((p) => p.questionId === q.id)!;
        return {
          id: q.id,
          title: q.title,
          points: pq.points,
          type: pq.type,
          auto: pq.auto,
          awarded: pq.auto ? pq.awarded : reviewMarks[q.id] ?? null,
        };
      }),
    });
  });
}
