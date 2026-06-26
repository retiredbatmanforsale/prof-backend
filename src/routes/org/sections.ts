import type { FastifyInstance } from "fastify";
import { OrgRole } from "@prisma/client";
import { parse } from "csv-parse/sync";
import { computeSectionMetrics } from "../../lib/orgMetrics.js";
import { computeSectionLessonTracking } from "../../lib/lessonTracking.js";
import { isStaffRole } from "../../lib/orgRole.js";
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

  // GET /org/sections/:id/assessments — assessments OWNED by this cohort, with
  // attempt + pending-review counts (Phase 6 faculty review surface).
  app.get<{ Params: { id: string } }>(
    "/sections/:id/assessments",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const section = await app.prisma.section.findFirst({
        where: { id: request.params.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!section) return reply.status(404).send({ error: "Section not found" });

      const rows = await app.prisma.assessment.findMany({
        where: { sectionId: section.id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          status: true,
          _count: { select: { questions: true } },
          attempts: { select: { status: true, pendingReview: true } },
        },
      });

      return reply.send({
        assessments: rows.map((a) => ({
          id: a.id,
          title: a.title,
          status: a.status,
          questionCount: a._count.questions,
          submittedCount: a.attempts.filter((x) => x.status === "SUBMITTED").length,
          pendingCount: a.attempts.filter((x) => x.pendingReview).length,
        })),
      });
    }
  );

  // GET /org/sections/:id/lessons — Phase 3 per-student lesson tracking for the
  // cohort drill-in: completed lessons, current lesson, solved practice, time
  // spent. Returns RAW facts; the UI applies curriculum weights for course %.
  app.get<{ Params: { id: string } }>(
    "/sections/:id/lessons",
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

      const tracking = await computeSectionLessonTracking(app.prisma, section.id);
      if (!tracking) {
        return reply.status(404).send({ error: "Section not found" });
      }
      return reply.send(tracking);
    }
  );

  // GET /org/sections/:id/invites — the cohort's invites (Pending / Accepted /
  // Expired). REUSES PreloadedStudent (the invite intent recorded at roster/CSV
  // time) + its InvitationToken — no separate invite model. Status:
  //   claimed=true                             → ACCEPTED
  //   claimed=false + a live unused token      → PENDING
  //   claimed=false + all tokens used/expired  → EXPIRED
  app.get<{ Params: { id: string } }>(
    "/sections/:id/invites",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const section = await app.prisma.section.findFirst({
        where: { id: request.params.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!section) return reply.status(404).send({ error: "Section not found" });

      const preloaded = await app.prisma.preloadedStudent.findMany({
        where: { sectionId: section.id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          name: true,
          claimed: true,
          createdAt: true,
          invitationTokens: { select: { expiresAt: true, used: true } },
        },
      });

      const now = new Date();
      const invites = preloaded.map((p) => {
        let status: "ACCEPTED" | "PENDING" | "EXPIRED";
        if (p.claimed) status = "ACCEPTED";
        else if (p.invitationTokens.some((t) => !t.used && t.expiresAt > now)) status = "PENDING";
        else status = "EXPIRED";
        return { id: p.id, email: p.email, name: p.name, status, invitedAt: p.createdAt.toISOString() };
      });

      return reply.send({ invites });
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
      if (!isStaffRole(member.orgRole)) {
        return reply.status(400).send({
          error: "Only faculty (university staff) can be assigned to a section",
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

  // Resolve a student's OrganizationMember id from their userId, scoped to the
  // caller's org. The faculty UI identifies students by userId everywhere, so
  // the roster mutations below take :userId and map to the SectionStudent FK
  // (organizationMemberId) here. Returns null if the user isn't a member.
  const resolveMemberId = async (userId: string, organizationId: string) => {
    const member = await app.prisma.organizationMember.findFirst({
      where: { userId, organizationId },
      select: { id: true },
    });
    return member?.id ?? null;
  };

  // DELETE /org/sections/:id/students/:userId — remove a student from this
  // cohort. Deletes ONLY the SectionStudent link; the member, their account, and
  // their (user-scoped) lesson/practice progress are untouched. Section-scoped
  // grade entries are intentionally KEPT — a removed student's marks are not
  // destroyed, they just drop out of the active roster view.
  app.delete<{ Params: { id: string; userId: string } }>(
    "/sections/:id/students/:userId",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const { id: sectionId, userId } = request.params;

      const section = await app.prisma.section.findFirst({
        where: { id: sectionId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!section) {
        return reply.status(404).send({ error: "Section not found" });
      }

      const memberId = await resolveMemberId(userId, ctx.organizationId);
      if (!memberId) {
        return reply
          .status(404)
          .send({ error: "Student not found in this organization" });
      }

      const link = await app.prisma.sectionStudent.findFirst({
        where: { sectionId: section.id, organizationMemberId: memberId },
        select: { id: true },
      });
      if (!link) {
        return reply.status(404).send({ error: "Student is not in this cohort" });
      }

      await app.prisma.sectionStudent.delete({ where: { id: link.id } });

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "SECTION_STUDENT_REMOVE",
        entityType: "SECTION",
        entityId: section.id,
        metadata: { organizationId: ctx.organizationId, userId, memberId },
        log: request.log,
      });

      return reply.send({ success: true });
    }
  );

  // POST /org/sections/:id/students/:userId/move — move a student from this
  // cohort to another in the SAME org. Atomic: the old SectionStudent link is
  // deleted and the new one created in a single transaction, so the one-cohort
  // invariant is never violated and the student is never briefly in zero or two
  // cohorts. Old-cohort grade entries are KEPT (see DELETE above); the new
  // cohort starts fresh.
  app.post<{
    Params: { id: string; userId: string };
    Body: { toSectionId?: string };
  }>(
    "/sections/:id/students/:userId/move",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const { id: fromSectionId, userId } = request.params;
      const toSectionId = (request.body?.toSectionId ?? "").trim();

      if (!toSectionId) {
        return reply.status(400).send({ error: "`toSectionId` is required" });
      }
      if (toSectionId === fromSectionId) {
        return reply.status(400).send({ error: "Student is already in this cohort" });
      }

      // Both the source and destination sections must belong to the caller's org.
      const sections = await app.prisma.section.findMany({
        where: {
          id: { in: [fromSectionId, toSectionId] },
          organizationId: ctx.organizationId,
        },
        select: { id: true },
      });
      const found = new Set(sections.map((s) => s.id));
      if (!found.has(fromSectionId) || !found.has(toSectionId)) {
        return reply.status(404).send({ error: "Section not found" });
      }

      // The student must belong to this org and currently be in the source cohort.
      const memberId = await resolveMemberId(userId, ctx.organizationId);
      if (!memberId) {
        return reply
          .status(404)
          .send({ error: "Student not found in this organization" });
      }
      const link = await app.prisma.sectionStudent.findFirst({
        where: { sectionId: fromSectionId, organizationMemberId: memberId },
        select: { id: true },
      });
      if (!link) {
        return reply
          .status(404)
          .send({ error: "Student is not in the source cohort" });
      }

      // Delete-then-create in one transaction: the old link is gone before the
      // new one is written, so the unique([organizationMemberId]) one-cohort
      // constraint never trips.
      await app.prisma.$transaction([
        app.prisma.sectionStudent.delete({ where: { id: link.id } }),
        app.prisma.sectionStudent.create({
          data: { sectionId: toSectionId, organizationMemberId: memberId },
        }),
      ]);

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "SECTION_STUDENT_MOVE",
        entityType: "SECTION",
        entityId: toSectionId,
        metadata: {
          organizationId: ctx.organizationId,
          userId,
          memberId,
          fromSectionId,
          toSectionId,
        },
        log: request.log,
      });

      return reply.send({ success: true });
    }
  );

  // POST /org/sections/:id/students/invite — manually add NEW students by email
  // to THIS cohort (manual entry or a client-parsed CSV). Same two-way handshake
  // as the roster CSV: each email is preloaded with this section recorded;
  // already-joined students are linked immediately, the rest get an invitation
  // email and become members only once they accept.
  app.post<{
    Params: { id: string };
    Body: { students?: Array<{ email?: string; name?: string }> };
  }>(
    "/sections/:id/students/invite",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const input = Array.isArray(request.body?.students) ? request.body!.students : [];
      if (input.length === 0) {
        return reply
          .status(400)
          .send({ error: "`students` (non-empty array of { email, name? }) is required" });
      }
      if (input.length > 500) {
        return reply.status(400).send({ error: "Maximum 500 students per request" });
      }

      const section = await app.prisma.section.findFirst({
        where: { id: request.params.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!section) {
        return reply.status(404).send({ error: "Section not found" });
      }

      const results = {
        sectionsTouched: 1,
        studentsPreloaded: 0,
        studentsLinked: 0,
        invited: 0,
        errors: [] as string[],
      };

      for (let i = 0; i < input.length; i++) {
        const email = (input[i]?.email || "").toLowerCase().trim();
        const name = (input[i]?.name || "").trim() || null;
        if (!email || !emailRegex.test(email)) {
          results.errors.push(`Row ${i + 1}: invalid email "${email}"`);
          continue;
        }
        try {
          const student = await app.prisma.preloadedStudent.upsert({
            where: { organizationId_email: { organizationId: ctx.organizationId, email } },
            create: {
              email,
              name,
              organizationId: ctx.organizationId,
              orgRole: OrgRole.STUDENT,
              sectionId: section.id,
            },
            update: { sectionId: section.id, ...(name ? { name } : {}) },
          });
          results.studentsPreloaded++;

          if (student.claimed && student.claimedByUserId) {
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
                    sectionId: section.id,
                    organizationMemberId: member.id,
                  },
                },
                create: { sectionId: section.id, organizationMemberId: member.id },
                update: {},
              });
              results.studentsLinked++;
            }
            continue;
          }

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
            await sendInvitationEmail(email, ctx.organizationName, rawToken);
          } catch (err) {
            app.log.error(err, `Failed to send invitation to ${email}`);
          }
          results.invited++;
        } catch (err) {
          app.log.error(err, `Failed to process ${email}`);
          results.errors.push(`Row ${i + 1}: failed to process "${email}"`);
        }
      }

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "SECTION_STUDENTS_INVITE",
        entityType: "SECTION",
        entityId: section.id,
        metadata: { organizationId: ctx.organizationId, ...results, errors: results.errors.length },
        log: request.log,
      });

      return reply.send({ success: true, ...results });
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
