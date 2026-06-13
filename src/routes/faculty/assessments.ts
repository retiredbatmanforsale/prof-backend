import type { FastifyInstance } from "fastify";
import { AssessmentStatus } from "@prisma/client";
import type { Assessment, AssessmentQuestion } from "@prisma/client";
import {
  createAssessmentSchema,
  updateAssessmentSchema,
} from "../../schemas/assessment.js";
import {
  questionCreateData,
  metadataData,
  serializeAssessmentSummary,
  serializeQuestionForFaculty,
} from "../../lib/assessments.js";
import { recordAdminAction } from "../../lib/audit.js";

/**
 * Faculty assessment authoring under /faculty/*. Auth + faculty guard are
 * applied at the parent (faculty/index.ts), which resolves
 * request.facultyContext = { organizationId, organizationName, memberId }.
 *
 * Ownership model (v1): a faculty member manages the assessments they
 * authored (createdByMemberId === ctx.memberId). Cohort assignment is scoped
 * to sections the caller actually teaches (SectionAssignment) — a faculty
 * member can't assign an assessment to a cohort they don't teach.
 *
 * Save is composite: POST/PATCH carry meta + questions[] + sectionIds[] and
 * persist transactionally. `questions`/`sectionIds`, when present on PATCH,
 * REPLACE the existing set (the UI sends the full intended state).
 *
 * Out of scope: evaluation, grading, plagiarism, execution.
 */
export default async function facultyAssessmentRoutes(app: FastifyInstance) {
  const rateLimit = { max: 60, timeWindow: "1 minute" } as const;

  // Validate that every sectionId is in the caller's org AND assigned to the
  // caller. Returns null on success, or an error descriptor for the handler.
  async function assertSectionsTeachable(
    organizationId: string,
    memberId: string,
    sectionIds: string[]
  ): Promise<{ status: number; error: string } | null> {
    const unique = [...new Set(sectionIds)];
    if (unique.length === 0) return null;

    const assignments = await app.prisma.sectionAssignment.findMany({
      where: {
        organizationMemberId: memberId,
        sectionId: { in: unique },
        section: { organizationId },
      },
      select: { sectionId: true },
    });
    const teachable = new Set(assignments.map((a) => a.sectionId));
    const missing = unique.filter((id) => !teachable.has(id));
    if (missing.length > 0) {
      return {
        status: 403,
        error: `Not assigned to section(s): ${missing.join(", ")}`,
      };
    }
    return null;
  }

  // GET /faculty/assessments — assessments authored by the caller.
  app.get(
    "/assessments",
    { config: { rateLimit } },
    async (request, reply) => {
      const ctx = request.facultyContext!;
      const assessments = await app.prisma.assessment.findMany({
        where: {
          organizationId: ctx.organizationId,
          createdByMemberId: ctx.memberId,
        },
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { questions: true, assignments: true } } },
      });
      return reply.send({
        assessments: assessments.map(serializeAssessmentSummary),
      });
    }
  );

  // GET /faculty/assessments/:id — full detail (questions + assigned cohorts).
  app.get<{ Params: { id: string } }>(
    "/assessments/:id",
    { config: { rateLimit } },
    async (request, reply) => {
      const ctx = request.facultyContext!;
      const assessment = await app.prisma.assessment.findFirst({
        where: {
          id: request.params.id,
          organizationId: ctx.organizationId,
          createdByMemberId: ctx.memberId,
        },
        include: {
          questions: { orderBy: { order: "asc" } },
          assignments: {
            include: { section: { select: { id: true, name: true, course: true } } },
          },
        },
      });
      if (!assessment) {
        return reply.status(404).send({ error: "Assessment not found" });
      }

      return reply.send({ assessment: serializeDetail(assessment) });
    }
  );

  // GET /faculty/assessments/:id/results — real analytics from
  // assessment_attempts (no grading — participation/progress/integrity-signal
  // free). Faculty-scoped to assessments they authored.
  app.get<{ Params: { id: string } }>(
    "/assessments/:id/results",
    { config: { rateLimit } },
    async (request, reply) => {
      const ctx = request.facultyContext!;
      const a = await app.prisma.assessment.findFirst({
        where: {
          id: request.params.id,
          organizationId: ctx.organizationId,
          createdByMemberId: ctx.memberId,
        },
        include: {
          questions: { orderBy: { order: "asc" }, select: { id: true, order: true, title: true, kind: true } },
          assignments: { select: { sectionId: true } },
          attempts: { include: { user: { select: { name: true, email: true } } } },
        },
      });
      if (!a) return reply.status(404).send({ error: "Assessment not found" });

      // Distinct students across the assigned cohorts = the denominator.
      const sectionIds = a.assignments.map((x) => x.sectionId);
      const roster = sectionIds.length
        ? await app.prisma.sectionStudent.findMany({
            where: { sectionId: { in: sectionIds } },
            select: { organizationMemberId: true },
            distinct: ["organizationMemberId"],
          })
        : [];

      return reply.send({ results: buildResults(a, roster.length) });
    }
  );

  // POST /faculty/assessments — create (composite). Saves as DRAFT unless
  // `publish: true`.
  app.post(
    "/assessments",
    { config: { rateLimit } },
    async (request, reply) => {
      const ctx = request.facultyContext!;
      const parsed = createAssessmentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const body = parsed.data;

      const sectionIds = body.sectionIds ?? [];
      const sectionError = await assertSectionsTeachable(
        ctx.organizationId,
        ctx.memberId,
        sectionIds
      );
      if (sectionError) {
        return reply.status(sectionError.status).send({ error: sectionError.error });
      }

      const created = await app.prisma.assessment.create({
        data: {
          organizationId: ctx.organizationId,
          createdByMemberId: ctx.memberId,
          title: body.title,
          description: body.description ?? null,
          status: body.publish ? AssessmentStatus.PUBLISHED : AssessmentStatus.DRAFT,
          durationMinutes: body.durationMinutes ?? null,
          opensAt: body.opensAt ? new Date(body.opensAt) : null,
          dueAt: body.dueAt ? new Date(body.dueAt) : null,
          ...metadataData(body),
          questions: {
            create: (body.questions ?? []).map((q, i) => questionCreateData(q, i)),
          },
          assignments: {
            create: sectionIds.map((sectionId) => ({
              sectionId,
              assignedByMemberId: ctx.memberId,
            })),
          },
        },
        include: {
          questions: { orderBy: { order: "asc" } },
          assignments: {
            include: { section: { select: { id: true, name: true, course: true } } },
          },
        },
      });

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: body.publish ? "ASSESSMENT_PUBLISH" : "ASSESSMENT_CREATE",
        entityType: "ASSESSMENT",
        entityId: created.id,
        metadata: {
          organizationId: ctx.organizationId,
          title: created.title,
          questionCount: created.questions.length,
          cohortCount: created.assignments.length,
        },
        log: request.log,
      });

      return reply.status(201).send({ assessment: serializeDetail(created) });
    }
  );

  // PATCH /faculty/assessments/:id — composite save. Provided fields update;
  // questions/sectionIds, when present, REPLACE the existing set.
  app.patch<{ Params: { id: string } }>(
    "/assessments/:id",
    { config: { rateLimit } },
    async (request, reply) => {
      const ctx = request.facultyContext!;
      const parsed = updateAssessmentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const body = parsed.data;

      const existing = await app.prisma.assessment.findFirst({
        where: {
          id: request.params.id,
          organizationId: ctx.organizationId,
          createdByMemberId: ctx.memberId,
        },
        select: { id: true },
      });
      if (!existing) {
        return reply.status(404).send({ error: "Assessment not found" });
      }

      if (body.sectionIds) {
        const sectionError = await assertSectionsTeachable(
          ctx.organizationId,
          ctx.memberId,
          body.sectionIds
        );
        if (sectionError) {
          return reply.status(sectionError.status).send({ error: sectionError.error });
        }
      }

      // Build the meta update from only the provided fields.
      const metaData: Record<string, unknown> = { ...metadataData(body) };
      if (body.title !== undefined) metaData.title = body.title;
      if (body.description !== undefined) metaData.description = body.description;
      if (body.durationMinutes !== undefined) metaData.durationMinutes = body.durationMinutes;
      if (body.opensAt !== undefined)
        metaData.opensAt = body.opensAt ? new Date(body.opensAt) : null;
      if (body.dueAt !== undefined)
        metaData.dueAt = body.dueAt ? new Date(body.dueAt) : null;
      if (body.status !== undefined)
        metaData.status =
          body.status === "PUBLISHED"
            ? AssessmentStatus.PUBLISHED
            : AssessmentStatus.DRAFT;

      const tx: any[] = [
        app.prisma.assessment.update({
          where: { id: existing.id },
          data: metaData,
        }),
      ];

      if (body.questions) {
        tx.push(
          app.prisma.assessmentQuestion.deleteMany({
            where: { assessmentId: existing.id },
          })
        );
        tx.push(
          app.prisma.assessmentQuestion.createMany({
            data: body.questions.map((q, i) => ({
              ...questionCreateData(q, i),
              assessmentId: existing.id,
            })),
          })
        );
      }

      if (body.sectionIds) {
        tx.push(
          app.prisma.assessmentAssignment.deleteMany({
            where: { assessmentId: existing.id },
          })
        );
        tx.push(
          app.prisma.assessmentAssignment.createMany({
            data: body.sectionIds.map((sectionId) => ({
              assessmentId: existing.id,
              sectionId,
              assignedByMemberId: ctx.memberId,
            })),
            skipDuplicates: true,
          })
        );
      }

      await app.prisma.$transaction(tx);

      const updated = await app.prisma.assessment.findUnique({
        where: { id: existing.id },
        include: {
          questions: { orderBy: { order: "asc" } },
          assignments: {
            include: { section: { select: { id: true, name: true, course: true } } },
          },
        },
      });

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: body.status === "PUBLISHED" ? "ASSESSMENT_PUBLISH" : "ASSESSMENT_UPDATE",
        entityType: "ASSESSMENT",
        entityId: existing.id,
        metadata: { organizationId: ctx.organizationId },
        log: request.log,
      });

      return reply.send({ assessment: serializeDetail(updated!) });
    }
  );

  // POST /faculty/assessments/:id/publish — DRAFT → PUBLISHED.
  app.post<{ Params: { id: string } }>(
    "/assessments/:id/publish",
    { config: { rateLimit } },
    async (request, reply) => {
      const ctx = request.facultyContext!;
      const existing = await app.prisma.assessment.findFirst({
        where: {
          id: request.params.id,
          organizationId: ctx.organizationId,
          createdByMemberId: ctx.memberId,
        },
        select: { id: true },
      });
      if (!existing) {
        return reply.status(404).send({ error: "Assessment not found" });
      }

      const updated = await app.prisma.assessment.update({
        where: { id: existing.id },
        data: { status: AssessmentStatus.PUBLISHED },
        include: {
          questions: { orderBy: { order: "asc" } },
          assignments: {
            include: { section: { select: { id: true, name: true, course: true } } },
          },
        },
      });

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "ASSESSMENT_PUBLISH",
        entityType: "ASSESSMENT",
        entityId: existing.id,
        metadata: { organizationId: ctx.organizationId },
        log: request.log,
      });

      return reply.send({ assessment: serializeDetail(updated) });
    }
  );

  // DELETE /faculty/assessments/:id — delete (cascades questions + assignments).
  app.delete<{ Params: { id: string } }>(
    "/assessments/:id",
    { config: { rateLimit } },
    async (request, reply) => {
      const ctx = request.facultyContext!;
      const { count } = await app.prisma.assessment.deleteMany({
        where: {
          id: request.params.id,
          organizationId: ctx.organizationId,
          createdByMemberId: ctx.memberId,
        },
      });
      if (count === 0) {
        return reply.status(404).send({ error: "Assessment not found" });
      }

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "ASSESSMENT_DELETE",
        entityType: "ASSESSMENT",
        entityId: request.params.id,
        metadata: { organizationId: ctx.organizationId },
        log: request.log,
      });

      return reply.send({ success: true });
    }
  );
}

// ── Results analytics (pure aggregation over assessment_attempts) ──
type AttemptState = {
  answers: Record<string, unknown>;
  currentQuestion: number;
  flaggedQuestions: string[];
};
function parseState(raw: unknown): AttemptState {
  const s = (raw ?? {}) as Partial<AttemptState>;
  return {
    answers: s.answers ?? {},
    currentQuestion: typeof s.currentQuestion === "number" ? s.currentQuestion : 0,
    flaggedQuestions: Array.isArray(s.flaggedQuestions) ? s.flaggedQuestions : [],
  };
}
function answeredVal(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

type ResultsAttempt = {
  status: string;
  startedAt: Date;
  exitedAt: Date | null;
  answers: unknown;
  user: { name: string; email: string };
};
type ResultsAssessment = {
  questions: { id: string; order: number; title: string | null; kind: string }[];
  attempts: ResultsAttempt[];
};

function buildResults(a: ResultsAssessment, totalAssigned: number) {
  const qs = a.questions;
  const totalQ = qs.length || 1;
  const now = Date.now();

  const rows = a.attempts.map((at) => {
    const st = parseState(at.answers);
    const answered = qs.filter((q) => answeredVal(st.answers[q.id])).length;
    const end = at.exitedAt ? at.exitedAt.getTime() : now;
    const durationMs = Math.max(0, end - at.startedAt.getTime());
    return {
      name: at.user.name || at.user.email,
      status: at.status,
      startedAt: at.startedAt.toISOString(),
      submittedAt: at.status === "SUBMITTED" && at.exitedAt ? at.exitedAt.toISOString() : null,
      exitedAtMs: at.exitedAt ? at.exitedAt.getTime() : null,
      durationMs,
      currentQuestion: st.currentQuestion,
      flaggedCount: st.flaggedQuestions.length,
      answered,
      completionPct: Math.round((answered / totalQ) * 100),
      _state: st,
    };
  });

  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const submitted = count("SUBMITTED");

  const overview = {
    totalAssigned,
    started: rows.length,
    submitted,
    locked: count("LOCKED"),
    activeNow: count("IN_PROGRESS"),
    exited: count("EXITED"),
    completionPct: totalAssigned > 0 ? Math.round((submitted / totalAssigned) * 100) : 0,
  };

  // Leaderboard: submitted first (earliest), then highest completion.
  const leaderboard = rows
    .filter((r) => r.status === "SUBMITTED")
    .sort((x, y) => (x.exitedAtMs ?? 0) - (y.exitedAtMs ?? 0) || y.completionPct - x.completionPct)
    .map((r, i) => ({ rank: i + 1, name: r.name, completionPct: r.completionPct, durationMs: r.durationMs }));

  // Per-question analytics.
  const questions = qs.map((q) => {
    const answered = rows.filter((r) => answeredVal(r._state.answers[q.id])).length;
    const flagged = rows.filter((r) => r._state.flaggedQuestions.includes(q.id)).length;
    return {
      order: q.order,
      title: q.title ?? `Question ${q.order + 1}`,
      kind: q.kind,
      attempts: rows.length,
      answered,
      skipped: Math.max(0, rows.length - answered),
      flagged,
    };
  });

  // Activity feed (most recent first).
  const feed: { type: string; name: string; at: string }[] = [];
  for (const at of a.attempts) {
    const name = at.user.name || at.user.email;
    feed.push({ type: "started", name, at: at.startedAt.toISOString() });
    if (at.exitedAt) {
      const t = at.status === "SUBMITTED" ? "submitted" : at.status === "LOCKED" ? "locked" : at.status === "EXITED" ? "exited" : null;
      if (t) feed.push({ type: t, name, at: at.exitedAt.toISOString() });
    }
  }
  feed.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));

  const mostSkipped = [...questions].filter((q) => q.skipped > 0).sort((x, y) => y.skipped - x.skipped).slice(0, 5);
  const mostFlagged = [...questions].filter((q) => q.flagged > 0).sort((x, y) => y.flagged - x.flagged).slice(0, 5);

  return {
    overview,
    participants: rows.map(({ _state, exitedAtMs, ...r }) => r),
    leaderboard,
    questions,
    activity: feed.slice(0, 50),
    weakSpots: { mostSkipped, mostFlagged },
  };
}

// Detail shape shared by every faculty endpoint that returns one assessment.
type AssessmentDetail = Assessment & {
  questions: AssessmentQuestion[];
  assignments: { section: { id: string; name: string; course: string | null } }[];
};

function serializeDetail(a: AssessmentDetail) {
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    status: a.status,
    durationMinutes: a.durationMinutes,
    opensAt: a.opensAt?.toISOString() ?? null,
    dueAt: a.dueAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    questions: a.questions.map(serializeQuestionForFaculty),
    cohorts: a.assignments.map((as) => ({
      id: as.section.id,
      name: as.section.name,
      course: as.section.course,
    })),
  };
}
