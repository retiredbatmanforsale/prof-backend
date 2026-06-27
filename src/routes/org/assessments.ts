import type { FastifyInstance } from "fastify";
import { AssessmentStatus, AssessmentVisibility, Prisma } from "@prisma/client";
import {
  createAssessmentSchema,
  updateAssessmentSchema,
} from "../../schemas/assessment.js";
import {
  questionCreateData,
  metadataData,
  serializeQuestionForFaculty,
} from "../../lib/assessments.js";
import {
  autoGrade,
  applyReviewMarks,
  writeAutoGradeEntries,
} from "../../lib/grading.js";
import { recordAdminAction } from "../../lib/audit.js";

/**
 * Campus-admin assessment surface under /org/*. Auth + org-admin guard are
 * applied at the parent (org/index.ts), which resolves request.orgAdminContext.
 *
 * AUTHORIZATION (delegated, NOT supreme): every query is hard-scoped to the
 * caller's single organization — `organizationId = ctx.organizationId` — and
 * PROF_GLOBAL assessments are never visible or mutable here (those are Root
 * Admin only). A campus admin can manage assessments authored by their org's
 * faculty (any visibility in {ORGANIZATION, SECTION}) but can never reach
 * another org or a platform-global assessment.
 */
export default async function orgAssessmentRoutes(app: FastifyInstance) {
  const rateLimit = { max: 60, timeWindow: "1 minute" } as const;

  // The campus admin's own OrganizationMember id (authorship / assignedBy).
  async function adminMemberId(userId: string, organizationId: string): Promise<string | null> {
    const m = await app.prisma.organizationMember.findFirst({
      where: { userId, organizationId },
      select: { id: true },
    });
    return m?.id ?? null;
  }

  // Every section must belong to THIS org. Campus admin manages all org
  // sections (unlike faculty, who are limited to assigned sections).
  async function assertSectionsInOrg(
    organizationId: string,
    sectionIds: string[]
  ): Promise<{ status: number; error: string } | null> {
    const unique = [...new Set(sectionIds)];
    if (unique.length === 0) return null;
    const found = await app.prisma.section.findMany({
      where: { id: { in: unique }, organizationId },
      select: { id: true },
    });
    const ok = new Set(found.map((s) => s.id));
    const missing = unique.filter((id) => !ok.has(id));
    if (missing.length) {
      return { status: 404, error: `Section(s) not in your organization: ${missing.join(", ")}` };
    }
    return null;
  }

  // Org-scoped, never PROF_GLOBAL.
  const orgScopeWhere = (organizationId: string) => ({
    organizationId,
    visibility: { in: [AssessmentVisibility.ORGANIZATION, AssessmentVisibility.SECTION] },
  });

  const detailInclude = {
    questions: { orderBy: { order: "asc" as const } },
    // The single owning cohort (Phase 2 ownership; AssessmentAssignment dropped in Phase 8).
    section: { select: { id: true, name: true, course: true } },
    createdBy: { select: { user: { select: { id: true, name: true, email: true } } } },
    _count: { select: { attempts: true } },
  };

  function serializeOrgDetail(a: any) {
    return {
      id: a.id,
      title: a.title,
      description: a.description,
      status: a.status,
      visibility: a.visibility,
      track: a.track,
      attemptPolicy: a.attemptPolicy,
      lateEntryAllowed: a.lateEntryAllowed,
      shuffleQuestions: a.shuffleQuestions,
      navigationMode: a.navigationMode,
      autoSubmit: a.autoSubmit,
      durationMinutes: a.durationMinutes,
      opensAt: a.opensAt?.toISOString() ?? null,
      dueAt: a.dueAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
      creator: a.createdBy?.user ?? null,
      attemptCount: a._count?.attempts ?? 0,
      questions: a.questions.map(serializeQuestionForFaculty),
      // The single owning cohort (Phase 2). The AssessmentAssignment bridge and
      // the derived `cohorts[]` array were removed in Phase 8.
      section: a.section ? { id: a.section.id, name: a.section.name, course: a.section.course } : null,
    };
  }

  // GET /org/assessments — every assessment in the caller's org.
  app.get("/assessments", { config: { rateLimit } }, async (request, reply) => {
    const ctx = request.orgAdminContext!;
    const rows = await app.prisma.assessment.findMany({
      where: orgScopeWhere(ctx.organizationId),
      orderBy: { updatedAt: "desc" },
      include: {
        createdBy: { select: { user: { select: { name: true, email: true } } } },
        _count: { select: { questions: true, attempts: true } },
      },
    });
    return reply.send({
      organizationName: ctx.organizationName,
      assessments: rows.map((a) => ({
        id: a.id,
        title: a.title,
        status: a.status,
        visibility: a.visibility,
        track: a.track,
        durationMinutes: a.durationMinutes,
        dueAt: a.dueAt?.toISOString() ?? null,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        creatorName: a.createdBy?.user?.name ?? a.createdBy?.user?.email ?? "—",
        questionCount: a._count.questions,
        cohortCount: a.sectionId ? 1 : 0,
        attemptCount: a._count.attempts,
      })),
    });
  });

  // GET /org/assessments/:id — detail (org-scoped).
  app.get<{ Params: { id: string } }>("/assessments/:id", { config: { rateLimit } }, async (request, reply) => {
    const ctx = request.orgAdminContext!;
    const a = await app.prisma.assessment.findFirst({
      where: { id: request.params.id, ...orgScopeWhere(ctx.organizationId) },
      include: detailInclude,
    });
    if (!a) return reply.status(404).send({ error: "Assessment not found" });
    return reply.send({ assessment: serializeOrgDetail(a) });
  });

  // POST /org/assessments — create an ORGANIZATION-visibility assessment.
  app.post("/assessments", { config: { rateLimit } }, async (request, reply) => {
    const ctx = request.orgAdminContext!;
    const parsed = createAssessmentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    }
    const body = parsed.data;
    const memberId = await adminMemberId(request.currentUser!.userId, ctx.organizationId);
    if (!memberId) return reply.status(403).send({ error: "Not a member of this organization" });

    const sectionIds = body.sectionIds ?? [];
    const secErr = await assertSectionsInOrg(ctx.organizationId, sectionIds);
    if (secErr) return reply.status(secErr.status).send({ error: secErr.error });

    if (body.publish && (body.questions ?? []).length === 0) {
      return reply.status(400).send({
        error: "Cannot publish an assessment with no questions. Add at least one question, or save it as a draft.",
      });
    }

    const created = await app.prisma.assessment.create({
      data: {
        organizationId: ctx.organizationId,
        createdByMemberId: memberId,
        visibility: AssessmentVisibility.ORGANIZATION,
        title: body.title,
        description: body.description ?? null,
        status: body.publish ? AssessmentStatus.PUBLISHED : AssessmentStatus.DRAFT,
        durationMinutes: body.durationMinutes ?? null,
        opensAt: body.opensAt ? new Date(body.opensAt) : null,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        ...metadataData(body),
        // Phase 8: ownership is the single sectionId FK (AssessmentAssignment removed).
        sectionId: sectionIds[0] ?? null,
        questions: { create: (body.questions ?? []).map((q, i) => questionCreateData(q, i)) },
      },
      include: detailInclude,
    });

    await recordAdminAction({
      prisma: app.prisma, actor: request.currentUser!,
      action: body.publish ? "ASSESSMENT_PUBLISH" : "ASSESSMENT_CREATE",
      entityType: "ASSESSMENT", entityId: created.id,
      metadata: { organizationId: ctx.organizationId, scope: "ORG" }, log: request.log,
    });
    return reply.status(201).send({ assessment: serializeOrgDetail(created) });
  });

  // NEW (Phase 2): POST /org/sections/:sectionId/assessments — create an
  // assessment INSIDE a cohort. Ownership is implicit from the URL: no
  // sectionIds[] in the body, no AssessmentAssignment bridge — the assessment is
  // saved with assessment.sectionId.
  app.post<{ Params: { sectionId: string } }>(
    "/sections/:sectionId/assessments",
    { config: { rateLimit } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const { sectionId } = request.params;
      const parsed = createAssessmentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
      }
      const body = parsed.data;
      const memberId = await adminMemberId(request.currentUser!.userId, ctx.organizationId);
      if (!memberId) return reply.status(403).send({ error: "Not a member of this organization" });

      // The cohort must belong to the caller's org.
      const secErr = await assertSectionsInOrg(ctx.organizationId, [sectionId]);
      if (secErr) return reply.status(secErr.status).send({ error: secErr.error });

      if (body.publish && (body.questions ?? []).length === 0) {
        return reply.status(400).send({
          error: "Cannot publish an assessment with no questions. Add at least one question, or save it as a draft.",
        });
      }

      const created = await app.prisma.assessment.create({
        data: {
          organizationId: ctx.organizationId,
          createdByMemberId: memberId,
          sectionId, // ← ownership is implicit from the URL
          visibility: AssessmentVisibility.SECTION,
          title: body.title,
          description: body.description ?? null,
          status: body.publish ? AssessmentStatus.PUBLISHED : AssessmentStatus.DRAFT,
          durationMinutes: body.durationMinutes ?? null,
          opensAt: body.opensAt ? new Date(body.opensAt) : null,
          dueAt: body.dueAt ? new Date(body.dueAt) : null,
          ...metadataData(body),
          questions: { create: (body.questions ?? []).map((q, i) => questionCreateData(q, i)) },
          // Ownership is the sectionId FK (AssessmentAssignment removed in Phase 8).
        },
        include: detailInclude,
      });

      await recordAdminAction({
        prisma: app.prisma, actor: request.currentUser!,
        action: body.publish ? "ASSESSMENT_PUBLISH" : "ASSESSMENT_CREATE",
        entityType: "ASSESSMENT", entityId: created.id,
        metadata: { organizationId: ctx.organizationId, scope: "SECTION", sectionId }, log: request.log,
      });
      return reply.status(201).send({ assessment: serializeOrgDetail(created) });
    }
  );

  // PATCH /org/assessments/:id — edit any org assessment.
  app.patch<{ Params: { id: string } }>("/assessments/:id", { config: { rateLimit } }, async (request, reply) => {
    const ctx = request.orgAdminContext!;
    const parsed = updateAssessmentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    }
    const body = parsed.data;
    const existing = await app.prisma.assessment.findFirst({
      where: { id: request.params.id, ...orgScopeWhere(ctx.organizationId) },
      select: { id: true },
    });
    if (!existing) return reply.status(404).send({ error: "Assessment not found" });

    // Guard: once students have attempted, the question set is frozen (metadata
    // edits stay allowed). Prevents corrupting in-flight attempts and scoring.
    if (body.questions) {
      const attempts = await app.prisma.assessmentAttempt.count({ where: { assessmentId: existing.id } });
      if (attempts > 0) {
        return reply.status(409).send({
          error:
            "This assessment already has student attempts, so its questions can no longer be changed. You can still edit the title, description, and dates.",
        });
      }
    }

    // Guard: never let an assessment go live with zero questions.
    if (body.status === "PUBLISHED") {
      const willHaveQuestions = body.questions
        ? body.questions.length
        : await app.prisma.assessmentQuestion.count({ where: { assessmentId: existing.id } });
      if (willHaveQuestions === 0) {
        return reply.status(400).send({ error: "Cannot publish an assessment with no questions." });
      }
    }

    if (body.sectionIds) {
      const secErr = await assertSectionsInOrg(ctx.organizationId, body.sectionIds);
      if (secErr) return reply.status(secErr.status).send({ error: secErr.error });
    }
    const metaData: Record<string, unknown> = { ...metadataData(body) };
    if (body.title !== undefined) metaData.title = body.title;
    if (body.description !== undefined) metaData.description = body.description;
    if (body.durationMinutes !== undefined) metaData.durationMinutes = body.durationMinutes;
    if (body.opensAt !== undefined) metaData.opensAt = body.opensAt ? new Date(body.opensAt) : null;
    if (body.dueAt !== undefined) metaData.dueAt = body.dueAt ? new Date(body.dueAt) : null;
    if (body.status !== undefined) metaData.status = body.status === "PUBLISHED" ? AssessmentStatus.PUBLISHED : AssessmentStatus.DRAFT;
    // Phase 8: re-target ownership via the sectionId FK (no AssessmentAssignment).
    if (body.sectionIds !== undefined) metaData.sectionId = body.sectionIds[0] ?? null;

    const tx: Prisma.PrismaPromise<unknown>[] = [
      app.prisma.assessment.update({ where: { id: existing.id }, data: metaData }),
    ];
    if (body.questions) {
      tx.push(app.prisma.assessmentQuestion.deleteMany({ where: { assessmentId: existing.id } }));
      tx.push(app.prisma.assessmentQuestion.createMany({
        data: body.questions.map((q, i) => ({ ...questionCreateData(q, i), assessmentId: existing.id })),
      }));
    }
    await app.prisma.$transaction(tx);

    const updated = await app.prisma.assessment.findUnique({ where: { id: existing.id }, include: detailInclude });
    await recordAdminAction({
      prisma: app.prisma, actor: request.currentUser!,
      action: body.status === "PUBLISHED" ? "ASSESSMENT_PUBLISH" : "ASSESSMENT_UPDATE",
      entityType: "ASSESSMENT", entityId: existing.id,
      metadata: { organizationId: ctx.organizationId, scope: "ORG" }, log: request.log,
    });
    return reply.send({ assessment: serializeOrgDetail(updated) });
  });

  // POST /org/assessments/:id/publish
  app.post<{ Params: { id: string } }>("/assessments/:id/publish", { config: { rateLimit } }, async (request, reply) => {
    const ctx = request.orgAdminContext!;
    const existing = await app.prisma.assessment.findFirst({
      where: { id: request.params.id, ...orgScopeWhere(ctx.organizationId) }, select: { id: true },
    });
    if (!existing) return reply.status(404).send({ error: "Assessment not found" });

    const qCount = await app.prisma.assessmentQuestion.count({ where: { assessmentId: existing.id } });
    if (qCount === 0) {
      return reply.status(400).send({ error: "Cannot publish an assessment with no questions." });
    }

    const updated = await app.prisma.assessment.update({
      where: { id: existing.id }, data: { status: AssessmentStatus.PUBLISHED }, include: detailInclude,
    });
    await recordAdminAction({
      prisma: app.prisma, actor: request.currentUser!, action: "ASSESSMENT_PUBLISH",
      entityType: "ASSESSMENT", entityId: existing.id, metadata: { organizationId: ctx.organizationId, scope: "ORG" }, log: request.log,
    });
    return reply.send({ assessment: serializeOrgDetail(updated) });
  });

  // POST /org/assessments/:id/archive — unpublish (back to DRAFT). NOTE: a
  // dedicated ARCHIVED state needs one more additive column; until then this
  // removes it from students by reverting to draft.
  app.post<{ Params: { id: string } }>("/assessments/:id/archive", { config: { rateLimit } }, async (request, reply) => {
    const ctx = request.orgAdminContext!;
    const existing = await app.prisma.assessment.findFirst({
      where: { id: request.params.id, ...orgScopeWhere(ctx.organizationId) }, select: { id: true },
    });
    if (!existing) return reply.status(404).send({ error: "Assessment not found" });
    const updated = await app.prisma.assessment.update({
      where: { id: existing.id }, data: { status: AssessmentStatus.DRAFT }, include: detailInclude,
    });
    await recordAdminAction({
      prisma: app.prisma, actor: request.currentUser!, action: "ASSESSMENT_UPDATE",
      entityType: "ASSESSMENT", entityId: existing.id, metadata: { organizationId: ctx.organizationId, scope: "ORG", op: "archive" }, log: request.log,
    });
    return reply.send({ assessment: serializeOrgDetail(updated) });
  });

  // POST /org/assessments/:id/duplicate — clone any org assessment (incl
  // faculty-authored) into a new DRAFT owned by the campus admin.
  app.post<{ Params: { id: string } }>("/assessments/:id/duplicate", { config: { rateLimit } }, async (request, reply) => {
    const ctx = request.orgAdminContext!;
    const src = await app.prisma.assessment.findFirst({
      where: { id: request.params.id, ...orgScopeWhere(ctx.organizationId) },
      include: { questions: { orderBy: { order: "asc" } } },
    });
    if (!src) return reply.status(404).send({ error: "Assessment not found" });
    const memberId = await adminMemberId(request.currentUser!.userId, ctx.organizationId);
    if (!memberId) return reply.status(403).send({ error: "Not a member of this organization" });

    const copy = await app.prisma.assessment.create({
      data: {
        organizationId: ctx.organizationId,
        createdByMemberId: memberId,
        visibility: AssessmentVisibility.ORGANIZATION,
        title: `${src.title} (copy)`,
        description: src.description,
        status: AssessmentStatus.DRAFT,
        track: src.track,
        attemptPolicy: src.attemptPolicy,
        lateEntryAllowed: src.lateEntryAllowed,
        shuffleQuestions: src.shuffleQuestions,
        navigationMode: src.navigationMode,
        autoSubmit: src.autoSubmit,
        durationMinutes: src.durationMinutes,
        // Phase 8: copy the owning cohort via the sectionId FK.
        sectionId: src.sectionId,
        questions: {
          create: src.questions.map((q) => ({
            order: q.order, kind: q.kind, points: q.points,
            catalogSlug: q.catalogSlug, title: q.title,
            content: (q.content ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          })),
        },
      },
      include: detailInclude,
    });
    await recordAdminAction({
      prisma: app.prisma, actor: request.currentUser!, action: "ASSESSMENT_CREATE",
      entityType: "ASSESSMENT", entityId: copy.id,
      metadata: { organizationId: ctx.organizationId, scope: "ORG", duplicatedFrom: src.id }, log: request.log,
    });
    return reply.status(201).send({ assessment: serializeOrgDetail(copy) });
  });

  // ─── Phase 6: faculty review + grading of attempts ───

  // Load an assessment in the caller's org with its questions.
  async function loadOrgAssessment(assessmentId: string, organizationId: string) {
    return app.prisma.assessment.findFirst({
      where: { id: assessmentId, ...orgScopeWhere(organizationId) },
      include: { questions: { orderBy: { order: "asc" } } },
    });
  }

  // GET /org/assessments/:id/attempts — one row per student who has an attempt.
  app.get<{ Params: { id: string } }>(
    "/assessments/:id/attempts",
    { config: { rateLimit } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const assessment = await loadOrgAssessment(request.params.id, ctx.organizationId);
      if (!assessment) return reply.status(404).send({ error: "Assessment not found" });

      const attempts = await app.prisma.assessmentAttempt.findMany({
        where: { assessmentId: assessment.id },
        orderBy: { submittedAt: "desc" },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      return reply.send({
        assessmentId: assessment.id,
        title: assessment.title,
        attempts: attempts.map((at) => ({
          attemptId: at.id,
          student: at.user,
          status: at.status,
          score: at.score ?? null,
          maxScore: at.maxScore ?? null,
          pendingReview: at.pendingReview,
          submittedAt: at.submittedAt?.toISOString() ?? null,
          gradedAt: at.gradedAt?.toISOString() ?? null,
        })),
      });
    }
  );

  // GET /org/assessments/:id/attempts/:attemptId — full attempt for review:
  // every question (with answer keys), the student's answer, and current marks.
  app.get<{ Params: { id: string; attemptId: string } }>(
    "/assessments/:id/attempts/:attemptId",
    { config: { rateLimit } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const assessment = await loadOrgAssessment(request.params.id, ctx.organizationId);
      if (!assessment) return reply.status(404).send({ error: "Assessment not found" });

      const attempt = await app.prisma.assessmentAttempt.findFirst({
        where: { id: request.params.attemptId, assessmentId: assessment.id },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      if (!attempt) return reply.status(404).send({ error: "Attempt not found" });

      const state = (attempt.answers ?? {}) as { answers?: Record<string, unknown> };
      const answers = state.answers ?? {};
      const graded = autoGrade(assessment.questions, answers);
      const reviewMarks = (attempt.reviewMarks ?? {}) as Record<string, number>;

      return reply.send({
        attemptId: attempt.id,
        student: attempt.user,
        status: attempt.status,
        score: attempt.score ?? null,
        maxScore: attempt.maxScore ?? graded.maxScore,
        pendingReview: attempt.pendingReview,
        submittedAt: attempt.submittedAt?.toISOString() ?? null,
        questions: assessment.questions.map((q) => {
          const pq = graded.perQuestion.find((p) => p.questionId === q.id)!;
          return {
            ...serializeQuestionForFaculty(q),
            answer: answers[q.id] ?? null,
            auto: pq.auto,
            awarded: pq.auto ? pq.awarded : reviewMarks[q.id] ?? null,
            maxPoints: pq.points,
          };
        }),
      });
    }
  );

  // POST /org/assessments/:id/attempts/:attemptId/grade — assign marks to the
  // non-auto questions and (optionally) finalize. Finalizing recomputes the
  // score and pushes it into AUTO gradebook components.
  app.post<{ Params: { id: string; attemptId: string }; Body: { reviewMarks?: Record<string, number>; finalize?: boolean } }>(
    "/assessments/:id/attempts/:attemptId/grade",
    { config: { rateLimit } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const assessment = await loadOrgAssessment(request.params.id, ctx.organizationId);
      if (!assessment) return reply.status(404).send({ error: "Assessment not found" });

      const attempt = await app.prisma.assessmentAttempt.findFirst({
        where: { id: request.params.attemptId, assessmentId: assessment.id },
      });
      if (!attempt) return reply.status(404).send({ error: "Attempt not found" });
      if (attempt.status !== "SUBMITTED") {
        return reply.status(409).send({ error: "Attempt is not submitted" });
      }

      const incoming = request.body?.reviewMarks ?? {};
      const existingMarks = (attempt.reviewMarks ?? {}) as Record<string, number>;
      const reviewMarks = { ...existingMarks, ...incoming };

      const state = (attempt.answers ?? {}) as { answers?: Record<string, unknown> };
      const answers = state.answers ?? {};
      const { score, maxScore, pendingQuestionIds } = applyReviewMarks(
        assessment.questions,
        answers,
        reviewMarks
      );

      const finalize = request.body?.finalize === true;
      const allResolved = pendingQuestionIds.length === 0;
      const nowFinal = finalize && allResolved;

      const updated = await app.prisma.assessmentAttempt.update({
        where: { id: attempt.id },
        data: {
          reviewMarks: reviewMarks as object,
          score,
          maxScore,
          pendingReview: !nowFinal,
          gradedAt: nowFinal ? new Date() : null,
        },
      });

      let gradebookWritten = 0;
      if (nowFinal) {
        gradebookWritten = await writeAutoGradeEntries(
          app.prisma,
          assessment.id,
          attempt.userId,
          score,
          maxScore
        );
      }

      return reply.send({
        attemptId: updated.id,
        score,
        maxScore,
        finalized: nowFinal,
        stillPending: pendingQuestionIds,
        gradebookEntriesWritten: gradebookWritten,
      });
    }
  );
}
