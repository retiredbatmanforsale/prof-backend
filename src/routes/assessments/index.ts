import type { FastifyInstance } from "fastify";
import { AssessmentStatus, AssessmentVisibility, AttemptStatus, Prisma } from "@prisma/client";
import type { AssessmentAttempt } from "@prisma/client";
import { authenticate } from "../../hooks/auth.js";
import {
  attemptStateSchema,
  assessmentRunCodeSchema,
  assessmentSubmitCodeSchema,
  assessmentIntegritySchema,
} from "../../schemas/assessment.js";
import { serializeQuestionForStudent } from "../../lib/assessments.js";
import { autoGrade, gradeAttempt, writeAutoGradeEntries } from "../../lib/grading.js";
import { isAttemptExpired, autoFinalizeAttempt } from "../../lib/attemptLifecycle.js";
import { runAssessmentCode, submitAssessmentCode } from "../../lib/assessment.service.js";
import { recordIntegrityEvent } from "../../lib/integrity.service.js";
import { NoTestsError } from "../../lib/judge.js";

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
    let attempt = await app.prisma.assessmentAttempt.findUnique({
      where: { assessmentId_userId: { assessmentId: a.id, userId } },
    });
    // Lazy enforcement: a timed-out attempt is auto-submitted on read.
    if (attempt && isAttemptExpired(a, attempt)) {
      attempt = await autoFinalizeAttempt(app.prisma, a, attempt);
    }
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

    // Faculty-set window. Start time gates entry; end time (dueAt) hard-closes
    // unless late entry is allowed.
    const now = new Date();
    if (a.opensAt && now < a.opensAt) {
      return reply.status(403).send({
        error: "NOT_OPEN",
        message: "This assessment hasn't opened yet.",
        opensAt: a.opensAt.toISOString(),
      });
    }
    if (a.dueAt && now > a.dueAt && !a.lateEntryAllowed) {
      return reply.status(403).send({
        error: "CLOSED",
        message: "This assessment has closed.",
        dueAt: a.dueAt.toISOString(),
      });
    }

    const existing = await app.prisma.assessmentAttempt.findUnique({
      where: { assessmentId_userId: { assessmentId: a.id, userId } },
    });

    if (existing) {
      // Lazy enforcement: an expired open attempt is auto-submitted, not resumed.
      // (Under UNLIMITED the student can call start again to retake a fresh one.)
      if (isAttemptExpired(a, existing)) {
        const finalized = await autoFinalizeAttempt(app.prisma, a, existing);
        return reply.send({ attempt: toAttempt(finalized), attemptPolicy: a.attemptPolicy, resumed: false, autoSubmitted: true });
      }
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
    // Lazy enforcement: reject saves past the deadline and auto-submit.
    const sa = await loadVisible(userId, request.params.id);
    if (sa && isAttemptExpired(sa, attempt)) {
      await autoFinalizeAttempt(app.prisma, sa, attempt);
      return reply.status(409).send({ error: "TIME_UP", message: "Time is up — your attempt was submitted automatically." });
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
    // Lazy enforcement: if time is already up, finalize rather than just exit.
    const ea = await loadVisible(userId, request.params.id);
    if (ea && isAttemptExpired(ea, attempt)) {
      const finalized = await autoFinalizeAttempt(app.prisma, ea, attempt);
      return reply.send({ attempt: toAttempt(finalized), attemptPolicy: ea.attemptPolicy });
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

    const prevReview = (attempt.reviewMarks ?? {}) as Record<string, number>;
    // Phase 4: coding questions auto-graded from their best CodeSubmission.
    const graded = await gradeAttempt(app.prisma, a.questions, attempt.id, state.answers, prevReview);
    const fullyGraded = graded.pendingQuestionIds.length === 0;
    const now = new Date();
    const mergedReview = { ...prevReview, ...graded.codingMarks };

    const updated = await app.prisma.assessmentAttempt.update({
      where: { id: attempt.id },
      data: {
        answers: state as object,
        status: AttemptStatus.SUBMITTED,
        submittedAt: now,
        score: graded.score,
        maxScore: graded.maxScore,
        reviewMarks: mergedReview as Prisma.InputJsonValue,
        pendingReview: !fullyGraded,
        gradedAt: fullyGraded ? now : null,
      },
    });

    // Fully graded (objective + coding, nothing left for faculty) → flows to gradebook.
    if (fullyGraded) {
      await writeAutoGradeEntries(app.prisma, a.id, userId, graded.score, graded.maxScore);
    }

    return reply.send({ attempt: toAttempt(updated), attemptPolicy: a.attemptPolicy });
  });

  // GET /assessments/:id/result — the student's own result (no answer keys).
  app.get<{ Params: { id: string } }>("/:id/result", async (request, reply) => {
    const userId = request.currentUser!.userId;
    const a = await loadVisible(userId, request.params.id);
    if (!a) return reply.status(404).send({ error: "Assessment not found" });
    let attempt = await getOwnAttempt(userId, a.id);
    // Lazy enforcement: an abandoned timed-out attempt is finalized before view.
    if (attempt && isAttemptExpired(a, attempt)) {
      attempt = await autoFinalizeAttempt(app.prisma, a, attempt);
    }
    if (!attempt || attempt.status !== "SUBMITTED") {
      return reply.status(404).send({ error: "No submitted attempt" });
    }
    const state = readState(attempt);
    const reviewMarks = (attempt.reviewMarks ?? {}) as Record<string, number>;
    // Phase 4: coding-aware view (coding shows as auto-graded with awarded marks).
    const graded = await gradeAttempt(app.prisma, a.questions, attempt.id, state.answers, reviewMarks);

    return reply.send({
      title: a.title,
      status: attempt.status,
      score: attempt.score ?? graded.score,
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
          awarded: pq.awarded,
        };
      }),
    });
  });

  // ─── Phase 3: proctoring integrity — server-authoritative warning budget ───
  // POST /assessments/:id/attempt/integrity — record a signal; the SERVER decides
  // warnings/termination. Client trusts the response (warningsIssued/remaining/
  // terminated/action), never its own count.
  app.post<{ Params: { id: string } }>("/:id/attempt/integrity", async (request, reply) => {
    const userId = request.currentUser!.userId;
    const body = assessmentIntegritySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Validation failed", details: body.error.flatten().fieldErrors });
    }
    const a = await loadVisible(userId, request.params.id);
    if (!a) return reply.status(404).send({ error: "Assessment not found" });
    const attempt = await getOwnAttempt(userId, a.id);
    if (!attempt) return reply.status(404).send({ error: "No attempt" });
    if (attempt.status === "SUBMITTED" || attempt.status === "LOCKED") {
      return reply.send({ warningsIssued: 0, remaining: 0, terminated: true, action: "NONE" });
    }
    // Reuse the timer gate: a timed-out attempt finalizes here too.
    if (isAttemptExpired(a, attempt)) {
      await autoFinalizeAttempt(app.prisma, a, attempt);
      return reply.send({ warningsIssued: 0, remaining: 0, terminated: true, action: "AUTO_SUBMITTED" });
    }
    const meta = body.data.meta as Record<string, unknown> | undefined;
    const result = await recordIntegrityEvent(app.prisma, {
      assessment: a,
      attempt,
      type: body.data.type,
      questionId: body.data.questionId ?? null,
      clientTs: body.data.clientTs ?? null,
      meta,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      fingerprint: (meta?.fingerprint as string | undefined) ?? null,
    });
    return reply.send(result);
  });

  // ─── Phase 2: coding questions (CATALOG) — run / submit within an attempt ───
  // The question's catalogSlug is the practice problem slug, so the SAME
  // problem_tests back both practice and assessments. Judging is delegated to the
  // SHARED judge (assessment.service → judge.ts). Attempt status + the existing
  // timer (attemptLifecycle) are enforced here before any execution.

  async function loadCodingQuestion(userId: string, assessmentId: string, qid: string) {
    const a = await loadVisible(userId, assessmentId);
    if (!a) return { error: "ASSESSMENT_NOT_FOUND" as const };
    const q = a.questions.find((x) => x.id === qid);
    if (!q) return { error: "QUESTION_NOT_FOUND" as const };
    if (q.kind !== "CATALOG" || !q.catalogSlug) return { error: "NOT_CODING" as const };
    return { a, q, slug: q.catalogSlug };
  }

  // POST /assessments/:id/questions/:qid/run — SAMPLE only; autosave; no submission.
  app.post<{ Params: { id: string; qid: string } }>(
    "/:id/questions/:qid/run",
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const body = assessmentRunCodeSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: "Validation failed", details: body.error.flatten().fieldErrors });
      }
      const ctx = await loadCodingQuestion(userId, request.params.id, request.params.qid);
      if ("error" in ctx) {
        return reply.status(ctx.error === "NOT_CODING" ? 400 : 404).send({ error: ctx.error });
      }
      const attempt = await getOwnAttempt(userId, ctx.a.id);
      if (!attempt || attempt.status === "SUBMITTED" || attempt.status === "LOCKED") {
        return reply.status(409).send({ error: "ATTEMPT_NOT_OPEN" });
      }
      if (isAttemptExpired(ctx.a, attempt)) {
        await autoFinalizeAttempt(app.prisma, ctx.a, attempt);
        return reply.status(409).send({ error: "TIME_UP", message: "Time is up — your attempt was submitted automatically." });
      }
      const result = await runAssessmentCode(app.prisma, {
        slug: ctx.slug,
        language: body.data.language,
        code: body.data.code,
      });
      // Autosave the draft code for this question + remember the active question.
      const state = readState(attempt);
      state.draftCode = { ...state.draftCode, [ctx.q.id]: body.data.code };
      await app.prisma.assessmentAttempt.update({
        where: { id: attempt.id },
        data: { answers: state as object, lastActiveQuestionId: ctx.q.id },
      });
      return reply.send({ success: true, result });
    }
  );

  // POST /assessments/:id/questions/:qid/submit — full suite; immutable CodeSubmission.
  app.post<{ Params: { id: string; qid: string } }>(
    "/:id/questions/:qid/submit",
    async (request, reply) => {
      const userId = request.currentUser!.userId;
      const body = assessmentSubmitCodeSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: "Validation failed", details: body.error.flatten().fieldErrors });
      }
      const ctx = await loadCodingQuestion(userId, request.params.id, request.params.qid);
      if ("error" in ctx) {
        return reply.status(ctx.error === "NOT_CODING" ? 400 : 404).send({ error: ctx.error });
      }
      const attempt = await getOwnAttempt(userId, ctx.a.id);
      if (!attempt || attempt.status === "SUBMITTED" || attempt.status === "LOCKED") {
        return reply.status(409).send({ error: "ATTEMPT_NOT_OPEN" });
      }
      if (isAttemptExpired(ctx.a, attempt)) {
        await autoFinalizeAttempt(app.prisma, ctx.a, attempt);
        return reply.status(409).send({ error: "TIME_UP", message: "Time is up — your attempt was submitted automatically." });
      }
      try {
        const result = await submitAssessmentCode(
          app.prisma,
          {
            userId,
            attemptId: attempt.id,
            assessmentId: ctx.a.id,
            questionId: ctx.q.id,
            organizationId: ctx.a.organizationId,
            sectionId: ctx.a.sectionId,
            ipAddress: request.ip,
            userAgent: request.headers["user-agent"] ?? null,
            clientFingerprint: body.data.fingerprint ?? null,
          },
          { slug: ctx.slug, language: body.data.language, code: body.data.code }
        );
        // Preserve the latest code as the draft for this question too.
        const state = readState(attempt);
        state.draftCode = { ...state.draftCode, [ctx.q.id]: body.data.code };
        await app.prisma.assessmentAttempt.update({
          where: { id: attempt.id },
          data: { answers: state as object, lastActiveQuestionId: ctx.q.id },
        });
        return reply.send({ success: true, result });
      } catch (err) {
        if (err instanceof NoTestsError) {
          return reply.status(422).send({ error: "NO_TESTS", message: "This problem has no tests configured yet." });
        }
        throw err;
      }
    }
  );
}
