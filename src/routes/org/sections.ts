import type { FastifyInstance } from "fastify";
import { OrgRole } from "@prisma/client";
import { parse } from "csv-parse/sync";
import { computeSectionMetrics } from "../../lib/orgMetrics.js";
import { isFacultyTierRole } from "../../lib/orgRole.js";
import { recordAdminAction } from "../../lib/audit.js";
import { generateToken } from "../../lib/tokens.js";
import { sendInvitationEmail } from "../../lib/email.js";

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Campus-admin section (cohort) routes under /org/*. Auth + org-admin guard
 * are applied at the parent (org/index.ts), which resolves
 * request.orgAdminContext — so every query here is scoped to the caller's org.
 *
 * Phase 1: read (list + per-section metrics). Phase 2: create / assign /
 * unassign / add-students / roster CSV. See SECTION_MODEL_PLAN.md.
 */
export default async function orgSectionsRoutes(app: FastifyInstance) {
  // GET /org/sections — all sections in the caller's org, with assigned staff
  // and a student count.
  app.get(
    "/sections",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const sections = await app.prisma.section.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          course: true,
          createdViaCsv: true,
          createdAt: true,
          _count: { select: { students: true } },
          staff: {
            select: {
              member: {
                select: {
                  id: true,
                  orgRole: true,
                  user: { select: { id: true, name: true, email: true } },
                },
              },
            },
          },
        },
      });

      return reply.send({
        sections: sections.map((s) => ({
          id: s.id,
          name: s.name,
          course: s.course,
          createdViaCsv: s.createdViaCsv,
          createdAt: s.createdAt.toISOString(),
          studentCount: s._count.students,
          staff: s.staff.map((a) => ({
            memberId: a.member.id,
            orgRole: a.member.orgRole,
            ...a.member.user,
          })),
        })),
      });
    }
  );

  // GET /org/sections/:id/metrics — cohort metrics for one section. 404 if the
  // section isn't in the caller's org (so an admin can't read another org's
  // cohort by guessing an id).
  app.get<{ Params: { id: string } }>(
    "/sections/:id/metrics",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const section = await app.prisma.section.findFirst({
        where: { id: request.params.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!section) {
        return reply.status(404).send({ error: "Section not found" });
      }

      const metrics = await computeSectionMetrics(app.prisma, section.id);
      if (!metrics) {
        return reply.status(404).send({ error: "Section not found" });
      }
      return reply.send(metrics);
    }
  );

  // POST /org/sections — create a section in the caller's org.
  app.post<{ Body: { name?: string; course?: string } }>(
    "/sections",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const name = (request.body?.name ?? "").trim();
      const course = request.body?.course?.trim() || null;
      if (!name) {
        return reply.status(400).send({ error: "Section `name` is required" });
      }

      const existing = await app.prisma.section.findUnique({
        where: { organizationId_name: { organizationId: ctx.organizationId, name } },
        select: { id: true },
      });
      if (existing) {
        return reply
          .status(409)
          .send({ error: `A section named "${name}" already exists` });
      }

      const section = await app.prisma.section.create({
        data: { organizationId: ctx.organizationId, name, course },
      });

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "SECTION_CREATE",
        entityType: "SECTION",
        entityId: section.id,
        metadata: { organizationId: ctx.organizationId, name, course },
        log: request.log,
      });

      return reply.status(201).send({
        section: {
          id: section.id,
          name: section.name,
          course: section.course,
          createdAt: section.createdAt.toISOString(),
        },
      });
    }
  );

  // POST /org/sections/:id/assign — assign a staff member (campus admin or
  // faculty-tier) to a section. Idempotent.
  app.post<{ Params: { id: string }; Body: { memberId?: string } }>(
    "/sections/:id/assign",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const memberId = (request.body?.memberId ?? "").trim();
      if (!memberId) {
        return reply.status(400).send({ error: "`memberId` is required" });
      }

      const section = await app.prisma.section.findFirst({
        where: { id: request.params.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!section) {
        return reply.status(404).send({ error: "Section not found" });
      }

      // The member must belong to the same org, and must be teaching staff.
      // Only faculty-tier roles (FACULTY / LAB_ASSISTANT / TA) may teach a
      // section — campus admins manage org-wide via /org and are NOT section
      // staff; students are learners. Everything else is rejected.
      const member = await app.prisma.organizationMember.findFirst({
        where: { id: memberId, organizationId: ctx.organizationId },
        select: { id: true, orgRole: true },
      });
      if (!member) {
        return reply
          .status(404)
          .send({ error: "Member not found in this organization" });
      }
      if (!isFacultyTierRole(member.orgRole)) {
        return reply.status(400).send({
          error: "Only teaching staff (faculty, lab assistant, or TA) can be assigned to a section",
        });
      }

      await app.prisma.sectionAssignment.upsert({
        where: {
          sectionId_organizationMemberId: {
            sectionId: section.id,
            organizationMemberId: member.id,
          },
        },
        create: {
          sectionId: section.id,
          organizationMemberId: member.id,
          assignedByUserId: request.currentUser!.userId,
        },
        update: {},
      });

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "SECTION_ASSIGN",
        entityType: "SECTION",
        entityId: section.id,
        metadata: { organizationId: ctx.organizationId, memberId: member.id, orgRole: member.orgRole },
        log: request.log,
      });

      return reply.send({ success: true });
    }
  );

  // DELETE /org/sections/:id/assign/:memberId — unassign a staff member.
  app.delete<{ Params: { id: string; memberId: string } }>(
    "/sections/:id/assign/:memberId",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const section = await app.prisma.section.findFirst({
        where: { id: request.params.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!section) {
        return reply.status(404).send({ error: "Section not found" });
      }

      const { count } = await app.prisma.sectionAssignment.deleteMany({
        where: {
          sectionId: section.id,
          organizationMemberId: request.params.memberId,
        },
      });

      if (count > 0) {
        await recordAdminAction({
          prisma: app.prisma,
          actor: request.currentUser!,
          action: "SECTION_UNASSIGN",
          entityType: "SECTION",
          entityId: section.id,
          metadata: { organizationId: ctx.organizationId, memberId: request.params.memberId },
          log: request.log,
        });
      }

      return reply.send({ success: true, removed: count });
    }
  );

  // POST /org/sections/:id/students — add existing org members (by id) to a
  // section. Validates each belongs to the org; ignores duplicates.
  app.post<{ Params: { id: string }; Body: { memberIds?: string[] } }>(
    "/sections/:id/students",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const memberIds = Array.isArray(request.body?.memberIds)
        ? request.body!.memberIds.filter((m) => typeof m === "string" && m.trim())
        : [];
      if (memberIds.length === 0) {
        return reply.status(400).send({ error: "`memberIds` (non-empty array) is required" });
      }

      const section = await app.prisma.section.findFirst({
        where: { id: request.params.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!section) {
        return reply.status(404).send({ error: "Section not found" });
      }

      // Only add members that actually belong to this org.
      const valid = await app.prisma.organizationMember.findMany({
        where: { id: { in: memberIds }, organizationId: ctx.organizationId },
        select: { id: true },
      });

      const { count } = await app.prisma.sectionStudent.createMany({
        data: valid.map((m) => ({ sectionId: section.id, organizationMemberId: m.id })),
        skipDuplicates: true,
      });

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "SECTION_STUDENTS_ADD",
        entityType: "SECTION",
        entityId: section.id,
        metadata: { organizationId: ctx.organizationId, requested: memberIds.length, added: count },
        log: request.log,
      });

      return reply.send({
        success: true,
        added: count,
        skippedInvalid: memberIds.length - valid.length,
      });
    }
  );

  // POST /org/sections/bulk — roster CSV. Header (case-insensitive):
  //   campus, section, course, studentName, studentEmail
  // Rows sharing campus+section group into one Section. Each student is
  // preloaded with the section recorded (PreloadedStudent.sectionId) so the
  // cohort link materializes on claim; already-joined students are linked
  // immediately; not-yet-joined students get an invitation email.
  app.post(
    "/sections/bulk",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;

      const file = await request.file();
      if (!file) {
        return reply.status(400).send({ error: "No file uploaded" });
      }
      const csvContent = (await file.toBuffer()).toString("utf-8");

      let records: Array<Record<string, string>>;
      try {
        records = parse(csvContent, {
          columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
          skip_empty_lines: true,
          trim: true,
        });
      } catch {
        return reply.status(400).send({
          error: "Invalid CSV. Expected columns: campus, section, course, studentName, studentEmail",
        });
      }
      if (records.length > 1000) {
        return reply.status(400).send({ error: "CSV file exceeds maximum of 1,000 rows" });
      }

      const results = {
        sectionsTouched: 0,
        studentsPreloaded: 0,
        studentsLinked: 0,
        invited: 0,
        errors: [] as string[],
      };
      const sectionIdByName = new Map<string, string>();

      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const sectionLabel = (row.section || "").trim();
        const campus = (row.campus || "").trim();
        const course = (row.course || "").trim() || null;
        const studentEmail = (row.studentemail || "").toLowerCase().trim();
        const studentName = (row.studentname || "").trim() || null;

        if (!sectionLabel) {
          results.errors.push(`Row ${i + 1}: missing section`);
          continue;
        }
        if (!studentEmail || !emailRegex.test(studentEmail)) {
          results.errors.push(`Row ${i + 1}: invalid studentEmail "${studentEmail}"`);
          continue;
        }

        // Campus disambiguates section names within the org (matches the POC's
        // campus+section grouping); omit it and the section name stands alone.
        const sectionName = campus ? `${campus} — ${sectionLabel}` : sectionLabel;

        try {
          let sectionId = sectionIdByName.get(sectionName);
          if (!sectionId) {
            const section = await app.prisma.section.upsert({
              where: { organizationId_name: { organizationId: ctx.organizationId, name: sectionName } },
              create: {
                organizationId: ctx.organizationId,
                name: sectionName,
                course,
                createdViaCsv: true,
              },
              update: course ? { course } : {},
            });
            sectionId = section.id;
            sectionIdByName.set(sectionName, sectionId);
            results.sectionsTouched++;
          }

          const student = await app.prisma.preloadedStudent.upsert({
            where: { organizationId_email: { organizationId: ctx.organizationId, email: studentEmail } },
            create: {
              email: studentEmail,
              name: studentName,
              organizationId: ctx.organizationId,
              orgRole: OrgRole.STUDENT,
              sectionId,
            },
            update: {
              sectionId,
              ...(studentName ? { name: studentName } : {}),
            },
          });
          results.studentsPreloaded++;

          if (student.claimed && student.claimedByUserId) {
            // Already joined — link their membership to the section now.
            const member = await app.prisma.organizationMember.findUnique({
              where: {
                userId_organizationId: {
                  userId: student.claimedByUserId,
                  organizationId: ctx.organizationId,
                },
              },
              select: { id: true },
            });
            if (member) {
              await app.prisma.sectionStudent.upsert({
                where: {
                  sectionId_organizationMemberId: {
                    sectionId,
                    organizationMemberId: member.id,
                  },
                },
                create: { sectionId, organizationMemberId: member.id },
                update: {},
              });
              results.studentsLinked++;
            }
            continue;
          }

          // Not yet joined — (re)issue an invite so they can claim.
          await app.prisma.invitationToken.updateMany({
            where: { preloadedStudentId: student.id, used: false },
            data: { used: true },
          });
          const rawToken = generateToken();
          await app.prisma.invitationToken.create({
            data: {
              token: rawToken,
              preloadedStudentId: student.id,
              expiresAt: new Date(Date.now() + INVITATION_EXPIRY_MS),
            },
          });
          try {
            await sendInvitationEmail(studentEmail, ctx.organizationName, rawToken);
          } catch (err) {
            app.log.error(err, `Failed to send invitation to ${studentEmail}`);
          }
          results.invited++;
        } catch (err) {
          app.log.error(err, `Row ${i + 1}: failed to process ${studentEmail}`);
          results.errors.push(`Row ${i + 1}: failed to process "${studentEmail}"`);
        }
      }

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "SECTION_BULK_UPLOAD",
        entityType: "SECTION",
        entityId: null,
        metadata: {
          organizationId: ctx.organizationId,
          ...results,
          errors: results.errors.length,
        },
        log: request.log,
      });

      return reply.send(results);
    }
  );
}
