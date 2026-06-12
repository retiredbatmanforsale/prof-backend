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
    assignments: { include: { section: { select: { id: true, name: true, course: true } } } },
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
      cohorts: a.assignments.map((x: any) => ({ id: x.section.id, name: x.section.name, course: x.section.course })),
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
        _count: { select: { questions: true, assignments: true, attempts: true } },
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
        cohortCount: a._count.assignments,
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
        questions: { create: (body.questions ?? []).map((q, i) => questionCreateData(q, i)) },
        assignments: { create: sectionIds.map((sectionId) => ({ sectionId, assignedByMemberId: memberId })) },
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

    if (body.sectionIds) {
      const secErr = await assertSectionsInOrg(ctx.organizationId, body.sectionIds);
      if (secErr) return reply.status(secErr.status).send({ error: secErr.error });
    }
    const memberId = await adminMemberId(request.currentUser!.userId, ctx.organizationId);

    const metaData: Record<string, unknown> = { ...metadataData(body) };
    if (body.title !== undefined) metaData.title = body.title;
    if (body.description !== undefined) metaData.description = body.description;
    if (body.durationMinutes !== undefined) metaData.durationMinutes = body.durationMinutes;
    if (body.opensAt !== undefined) metaData.opensAt = body.opensAt ? new Date(body.opensAt) : null;
    if (body.dueAt !== undefined) metaData.dueAt = body.dueAt ? new Date(body.dueAt) : null;
    if (body.status !== undefined) metaData.status = body.status === "PUBLISHED" ? AssessmentStatus.PUBLISHED : AssessmentStatus.DRAFT;

    const tx: Prisma.PrismaPromise<unknown>[] = [
      app.prisma.assessment.update({ where: { id: existing.id }, data: metaData }),
    ];
    if (body.questions) {
      tx.push(app.prisma.assessmentQuestion.deleteMany({ where: { assessmentId: existing.id } }));
      tx.push(app.prisma.assessmentQuestion.createMany({
        data: body.questions.map((q, i) => ({ ...questionCreateData(q, i), assessmentId: existing.id })),
      }));
    }
    if (body.sectionIds) {
      tx.push(app.prisma.assessmentAssignment.deleteMany({ where: { assessmentId: existing.id } }));
      tx.push(app.prisma.assessmentAssignment.createMany({
        data: body.sectionIds.map((sectionId) => ({ assessmentId: existing.id, sectionId, assignedByMemberId: memberId })),
        skipDuplicates: true,
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
      include: { questions: { orderBy: { order: "asc" } }, assignments: true },
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
        questions: {
          create: src.questions.map((q) => ({
            order: q.order, kind: q.kind, points: q.points,
            catalogSlug: q.catalogSlug, title: q.title,
            content: (q.content ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          })),
        },
        assignments: { create: src.assignments.map((x) => ({ sectionId: x.sectionId, assignedByMemberId: memberId })) },
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
}
