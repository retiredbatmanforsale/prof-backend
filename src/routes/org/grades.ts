import type { FastifyInstance } from "fastify";
import {
  createGradeComponentSchema,
  updateGradeComponentSchema,
  upsertGradeEntrySchema,
} from "../../schemas/grades.js";
import {
  resolveSectionGradebook,
  syncAssessmentGrades,
} from "../../lib/gradebook.js";

/**
 * Phase 5 gradebook (/org/sections/:id/grades*). Auth + requireOrgAdmin are
 * applied at the parent (org/index.ts). Every route re-verifies the section is
 * in the caller's org so an admin can't touch another org's gradebook.
 */
export default async function orgGradesRoutes(app: FastifyInstance) {
  async function adminMemberId(userId: string, organizationId: string) {
    const m = await app.prisma.organizationMember.findFirst({
      where: { userId, organizationId },
      select: { id: true },
    });
    return m?.id ?? null;
  }

  async function sectionInOrg(sectionId: string, organizationId: string) {
    return app.prisma.section.findFirst({
      where: { id: sectionId, organizationId },
      select: { id: true },
    });
  }

  // GET /org/sections/:id/grades — the full cohort gradebook.
  app.get<{ Params: { id: string } }>(
    "/sections/:id/grades",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const section = await sectionInOrg(request.params.id, ctx.organizationId);
      if (!section) return reply.status(404).send({ error: "Section not found" });

      const gradebook = await resolveSectionGradebook(app.prisma, section.id);
      if (!gradebook) return reply.status(404).send({ error: "Section not found" });
      return reply.send(gradebook);
    }
  );

  // POST /org/sections/:id/grade-components — add a weighted column.
  app.post<{ Params: { id: string } }>(
    "/sections/:id/grade-components",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const section = await sectionInOrg(request.params.id, ctx.organizationId);
      if (!section) return reply.status(404).send({ error: "Section not found" });

      const parsed = createGradeComponentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const body = parsed.data;

      // An AUTO-linked assessment must belong to this org.
      if (body.assessmentId) {
        const a = await app.prisma.assessment.findFirst({
          where: { id: body.assessmentId, organizationId: ctx.organizationId },
          select: { id: true },
        });
        if (!a) return reply.status(404).send({ error: "Linked assessment not found in your org" });
      }

      const component = await app.prisma.gradeComponent.create({
        data: {
          sectionId: section.id,
          name: body.name,
          type: body.type,
          maxMarks: body.maxMarks,
          weight: body.weight,
          assessmentId: body.assessmentId ?? null,
        },
      });
      return reply.status(201).send({ component });
    }
  );

  // PATCH /org/sections/:id/grade-components/:componentId — edit a column.
  app.patch<{ Params: { id: string; componentId: string } }>(
    "/sections/:id/grade-components/:componentId",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const section = await sectionInOrg(request.params.id, ctx.organizationId);
      if (!section) return reply.status(404).send({ error: "Section not found" });

      const parsed = updateGradeComponentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const existing = await app.prisma.gradeComponent.findFirst({
        where: { id: request.params.componentId, sectionId: section.id },
        select: { id: true },
      });
      if (!existing) return reply.status(404).send({ error: "Component not found" });

      const component = await app.prisma.gradeComponent.update({
        where: { id: existing.id },
        data: parsed.data,
      });
      return reply.send({ component });
    }
  );

  // DELETE /org/sections/:id/grade-components/:componentId — remove a column
  // (cascades its entries).
  app.delete<{ Params: { id: string; componentId: string } }>(
    "/sections/:id/grade-components/:componentId",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const section = await sectionInOrg(request.params.id, ctx.organizationId);
      if (!section) return reply.status(404).send({ error: "Section not found" });

      const existing = await app.prisma.gradeComponent.findFirst({
        where: { id: request.params.componentId, sectionId: section.id },
        select: { id: true },
      });
      if (!existing) return reply.status(404).send({ error: "Component not found" });

      await app.prisma.gradeComponent.delete({ where: { id: existing.id } });
      return reply.send({ success: true });
    }
  );

  // PUT /org/sections/:id/grade-entries — upsert a MANUAL score for one student
  // in one component.
  app.put<{ Params: { id: string } }>(
    "/sections/:id/grade-entries",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const section = await sectionInOrg(request.params.id, ctx.organizationId);
      if (!section) return reply.status(404).send({ error: "Section not found" });

      const parsed = upsertGradeEntrySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const { componentId, studentId, score } = parsed.data;

      // Component must belong to this section.
      const component = await app.prisma.gradeComponent.findFirst({
        where: { id: componentId, sectionId: section.id },
        select: { id: true, maxMarks: true },
      });
      if (!component) return reply.status(404).send({ error: "Component not found" });
      if (score > component.maxMarks) {
        return reply
          .status(400)
          .send({ error: `Score exceeds maxMarks (${component.maxMarks})` });
      }

      // Student must be an active member of this section.
      const inSection = await app.prisma.sectionStudent.findFirst({
        where: { sectionId: section.id, member: { userId: studentId } },
        select: { id: true },
      });
      if (!inSection) {
        return reply.status(404).send({ error: "Student not in this section" });
      }

      const memberId = await adminMemberId(
        request.currentUser!.userId,
        ctx.organizationId
      );

      const entry = await app.prisma.gradeEntry.upsert({
        where: { componentId_studentId: { componentId, studentId } },
        create: {
          componentId,
          studentId,
          score,
          source: "MANUAL",
          enteredByMemberId: memberId,
        },
        update: { score, source: "MANUAL", enteredByMemberId: memberId },
      });
      return reply.send({ entry });
    }
  );

  // POST /org/sections/:id/grades/sync — pull AUTO scores from linked
  // assessments (no-op until assessment grading exists; reports what's pending).
  app.post<{ Params: { id: string } }>(
    "/sections/:id/grades/sync",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const section = await sectionInOrg(request.params.id, ctx.organizationId);
      if (!section) return reply.status(404).send({ error: "Section not found" });

      const result = await syncAssessmentGrades(app.prisma, section.id);
      return reply.send(result);
    }
  );
}
