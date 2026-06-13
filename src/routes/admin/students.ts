import type { FastifyInstance } from "fastify";
import { OrgRole } from "@prisma/client";
import { parse } from "csv-parse/sync";
import { addStudentSchema } from "../../schemas/admin.js";
import { generateToken } from "../../lib/tokens.js";
import { sendInvitationEmail } from "../../lib/email.js";
import { recordAdminAction } from "../../lib/audit.js";
import { revokeAllUserTokens } from "../../lib/session.js";
import { isCampusAdminRole } from "../../lib/orgRole.js";

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export default async function studentRoutes(app: FastifyInstance) {
  // POST /organizations/:orgId/students — Add single student
  app.post<{ Params: { orgId: string } }>(
    "/organizations/:orgId/students",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = addStudentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const org = await app.prisma.organization.findUnique({
        where: { id: request.params.orgId },
      });
      if (!org) {
        return reply.status(404).send({ error: "Organization not found" });
      }

      const { email, name } = parsed.data;
      const normalizedEmail = email.toLowerCase();

      // Upsert PreloadedStudent
      const student = await app.prisma.preloadedStudent.upsert({
        where: {
          organizationId_email: {
            organizationId: org.id,
            email: normalizedEmail,
          },
        },
        create: {
          email: normalizedEmail,
          name: name || null,
          organizationId: org.id,
        },
        update: {
          name: name !== undefined ? name || null : undefined,
        },
      });

      // Invalidate old unused tokens for this student
      await app.prisma.invitationToken.updateMany({
        where: {
          preloadedStudentId: student.id,
          used: false,
        },
        data: { used: true },
      });

      // Generate new invitation token
      const rawToken = generateToken();
      await app.prisma.invitationToken.create({
        data: {
          token: rawToken,
          preloadedStudentId: student.id,
          expiresAt: new Date(Date.now() + INVITATION_EXPIRY_MS),
        },
      });

      // Send invitation email
      try {
        await sendInvitationEmail(normalizedEmail, org.name, rawToken);
      } catch (err) {
        app.log.error(err, "Failed to send invitation email");
      }

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "STUDENT_ADD",
        entityType: "PRELOADED_STUDENT",
        entityId: student.id,
        metadata: {
          organizationId: org.id,
          organizationName: org.name,
          email: normalizedEmail,
          name: student.name,
        },
        log: request.log,
      });

      return reply.status(201).send({
        success: true,
        student: {
          id: student.id,
          email: student.email,
          name: student.name,
          claimed: student.claimed,
        },
      });
    }
  );

  // POST /organizations/:orgId/students/bulk — CSV upload
  app.post<{ Params: { orgId: string } }>(
    "/organizations/:orgId/students/bulk",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const org = await app.prisma.organization.findUnique({
        where: { id: request.params.orgId },
      });
      if (!org) {
        return reply.status(404).send({ error: "Organization not found" });
      }

      const file = await request.file();
      if (!file) {
        return reply.status(400).send({ error: "No file uploaded" });
      }

      const buffer = await file.toBuffer();
      const csvContent = buffer.toString("utf-8");

      let records: Array<Record<string, string>>;
      try {
        records = parse(csvContent, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        });
      } catch {
        return reply
          .status(400)
          .send({ error: "Invalid CSV format. Expected columns: email, name (optional)" });
      }

      if (records.length > 10000) {
        return reply
          .status(400)
          .send({ error: "CSV file exceeds maximum of 10,000 rows" });
      }

      const results = { added: 0, skipped: 0, errors: [] as string[] };
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const email = (row.email || "").toLowerCase().trim();
        const name = (row.name || "").trim() || null;

        if (!email) {
          results.errors.push(`Row ${i + 1}: Missing email`);
          continue;
        }

        if (!emailRegex.test(email)) {
          results.errors.push(`Row ${i + 1}: Invalid email "${email}"`);
          continue;
        }

        try {
          // Upsert student
          const student = await app.prisma.preloadedStudent.upsert({
            where: {
              organizationId_email: {
                organizationId: org.id,
                email,
              },
            },
            create: {
              email,
              name,
              organizationId: org.id,
            },
            update: {
              name: name !== null ? name : undefined,
            },
          });

          if (student.claimed) {
            results.skipped++;
            continue;
          }

          // Invalidate old tokens
          await app.prisma.invitationToken.updateMany({
            where: {
              preloadedStudentId: student.id,
              used: false,
            },
            data: { used: true },
          });

          // Generate and send invitation
          const rawToken = generateToken();
          await app.prisma.invitationToken.create({
            data: {
              token: rawToken,
              preloadedStudentId: student.id,
              expiresAt: new Date(Date.now() + INVITATION_EXPIRY_MS),
            },
          });

          try {
            await sendInvitationEmail(email, org.name, rawToken);
          } catch (err) {
            app.log.error(err, `Failed to send invitation to ${email}`);
          }

          results.added++;
        } catch (err) {
          app.log.error(err, `Failed to process student ${email}`);
          results.errors.push(`Row ${i + 1}: Failed to process "${email}"`);
        }
      }

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "STUDENT_BULK_ADD",
        entityType: "ORGANIZATION",
        entityId: org.id,
        metadata: {
          organizationName: org.name,
          rowsTotal: records.length,
          added: results.added,
          skipped: results.skipped,
          errorCount: results.errors.length,
        },
        log: request.log,
      });

      return reply.send({ success: true, ...results });
    }
  );

  // POST /organizations/:orgId/admins/bulk — CSV upload of org-admin emails.
  // Each email is preloaded and marked isOrgAdmin so that on claim/auto-claim
  // the resulting OrganizationMember can view the org metrics dashboard
  // (/org/*). If the person has already joined, their membership is promoted
  // to org admin immediately; otherwise an invitation is (re)issued so they
  // can claim. CSV format: a single `email` column (header required).
  app.post<{ Params: { orgId: string } }>(
    "/organizations/:orgId/admins/bulk",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const org = await app.prisma.organization.findUnique({
        where: { id: request.params.orgId },
      });
      if (!org) {
        return reply.status(404).send({ error: "Organization not found" });
      }

      const file = await request.file();
      if (!file) {
        return reply.status(400).send({ error: "No file uploaded" });
      }

      const buffer = await file.toBuffer();
      const csvContent = buffer.toString("utf-8");

      let records: Array<Record<string, string>>;
      try {
        records = parse(csvContent, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        });
      } catch {
        return reply
          .status(400)
          .send({ error: "Invalid CSV format. Expected a single column: email" });
      }

      if (records.length > 1000) {
        return reply
          .status(400)
          .send({ error: "CSV file exceeds maximum of 1,000 rows" });
      }

      const results = {
        invited: 0,
        promoted: 0,
        errors: [] as string[],
      };
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const email = (row.email || "").toLowerCase().trim();

        if (!email) {
          results.errors.push(`Row ${i + 1}: Missing email`);
          continue;
        }

        if (!emailRegex.test(email)) {
          results.errors.push(`Row ${i + 1}: Invalid email "${email}"`);
          continue;
        }

        try {
          const student = await app.prisma.preloadedStudent.upsert({
            where: {
              organizationId_email: { organizationId: org.id, email },
            },
            create: {
              email,
              organizationId: org.id,
              isOrgAdmin: true,
              orgRole: OrgRole.CAMPUS_ADMIN,
            },
            update: { isOrgAdmin: true, orgRole: OrgRole.CAMPUS_ADMIN },
          });

          // Already joined? Promote the live membership now so the dashboard
          // unlocks on their next token refresh (≤ 15 min). The /org guard
          // re-checks the DB, so the API itself works immediately.
          if (student.claimed && student.claimedByUserId) {
            await app.prisma.organizationMember.updateMany({
              where: {
                userId: student.claimedByUserId,
                organizationId: org.id,
              },
              data: { isOrgAdmin: true, orgRole: OrgRole.CAMPUS_ADMIN },
            });
            results.promoted++;
            continue;
          }

          // Not yet joined — (re)issue an invite so they can claim. Mirrors
          // the student bulk invite flow.
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
            await sendInvitationEmail(email, org.name, rawToken);
          } catch (err) {
            app.log.error(err, `Failed to send invitation to ${email}`);
          }
          results.invited++;
        } catch (err) {
          app.log.error(err, `Failed to process admin ${email}`);
          results.errors.push(`Row ${i + 1}: Failed to process "${email}"`);
        }
      }

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "ORG_ADMIN_BULK_ADD",
        entityType: "ORGANIZATION",
        entityId: org.id,
        metadata: {
          organizationName: org.name,
          rowsTotal: records.length,
          invited: results.invited,
          promoted: results.promoted,
          errorCount: results.errors.length,
        },
        log: request.log,
      });

      return reply.send({ success: true, ...results });
    }
  );

  // GET /organizations/:orgId/students — List students
  app.get<{ Params: { orgId: string } }>(
    "/organizations/:orgId/students",
    async (request, reply) => {
      const org = await app.prisma.organization.findUnique({
        where: { id: request.params.orgId },
      });
      if (!org) {
        return reply.status(404).send({ error: "Organization not found" });
      }

      const students = await app.prisma.preloadedStudent.findMany({
        where: { organizationId: org.id },
        orderBy: { createdAt: "desc" },
        include: {
          claimedBy: { select: { id: true, name: true, email: true } },
        },
      });

      return reply.send({ students });
    }
  );

  // DELETE /organizations/:orgId/students/:id — Remove unclaimed student
  app.delete<{ Params: { orgId: string; id: string } }>(
    "/organizations/:orgId/students/:id",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const student = await app.prisma.preloadedStudent.findFirst({
        where: {
          id: request.params.id,
          organizationId: request.params.orgId,
        },
      });

      if (!student) {
        return reply.status(404).send({ error: "Student not found" });
      }

      if (student.claimed) {
        return reply
          .status(400)
          .send({ error: "Cannot remove a claimed student" });
      }

      await app.prisma.preloadedStudent.delete({
        where: { id: student.id },
      });

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "STUDENT_REMOVE",
        entityType: "PRELOADED_STUDENT",
        entityId: student.id,
        metadata: {
          organizationId: student.organizationId,
          email: student.email,
        },
        log: request.log,
      });

      return reply.send({ success: true });
    }
  );

  // PATCH /organizations/:orgId/members/:id — Update a claimed member's
  // institution access (`isActive`) and/or org-admin status (`isOrgAdmin`).
  // Either field may be sent independently. On revoke, the user's refresh
  // tokens are invalidated so their access collapses on the next refresh
  // (within the JWT TTL of 15 minutes). Granting/removing org-admin takes
  // effect for the /org dashboard immediately (the guard re-checks the DB)
  // and surfaces in their JWT on the next refresh.
  app.patch<{
    Params: { orgId: string; id: string };
    Body: { isActive?: boolean; isOrgAdmin?: boolean; orgRole?: OrgRole };
  }>(
    "/organizations/:orgId/members/:id",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { isActive, isOrgAdmin, orgRole } = request.body ?? {};

      // `orgRole` is the canonical tier; the legacy `isOrgAdmin` boolean is
      // still accepted and mapped (true → CAMPUS_ADMIN, false → STUDENT).
      // When both are sent, `orgRole` wins. Resolve the target tier (and keep
      // the boolean in lockstep) before touching the DB.
      if (orgRole !== undefined && !Object.values(OrgRole).includes(orgRole)) {
        return reply.status(400).send({
          error: `Invalid orgRole. Expected one of: ${Object.values(OrgRole).join(", ")}`,
        });
      }
      const roleProvided = orgRole !== undefined || typeof isOrgAdmin === "boolean";
      const targetRole: OrgRole | undefined =
        orgRole !== undefined
          ? orgRole
          : typeof isOrgAdmin === "boolean"
            ? isOrgAdmin
              ? OrgRole.CAMPUS_ADMIN
              : OrgRole.STUDENT
            : undefined;
      const targetIsOrgAdmin =
        targetRole !== undefined ? isCampusAdminRole(targetRole) : undefined;

      if (typeof isActive !== "boolean" && !roleProvided) {
        return reply.status(400).send({
          error: "Body must include boolean `isActive` and/or `orgRole` (or legacy `isOrgAdmin`)",
        });
      }

      const member = await app.prisma.organizationMember.findFirst({
        where: {
          id: request.params.id,
          organizationId: request.params.orgId,
        },
        include: {
          user: { select: { id: true, email: true, name: true } },
          organization: { select: { id: true, name: true } },
        },
      });

      if (!member) {
        return reply.status(404).send({ error: "Member not found" });
      }

      // Only persist dimensions that actually change. orgRole and isOrgAdmin
      // move together so the legacy boolean never drifts from the canonical tier.
      const data: { isActive?: boolean; isOrgAdmin?: boolean; orgRole?: OrgRole } = {};
      if (typeof isActive === "boolean" && isActive !== member.isActive) {
        data.isActive = isActive;
      }
      const roleChanged =
        roleProvided &&
        (targetRole !== member.orgRole || targetIsOrgAdmin !== member.isOrgAdmin);
      if (roleChanged) {
        data.orgRole = targetRole;
        data.isOrgAdmin = targetIsOrgAdmin;
      }

      if (Object.keys(data).length === 0) {
        return reply.send({
          success: true,
          member: {
            id: member.id,
            isActive: member.isActive,
            isOrgAdmin: member.isOrgAdmin,
            orgRole: member.orgRole,
            user: member.user,
          },
          unchanged: true,
        });
      }

      const updated = await app.prisma.organizationMember.update({
        where: { id: member.id },
        data,
      });

      // On revoke, kill the user's refresh tokens so their elevated
      // access can't survive past the current 15-minute access token TTL.
      if (data.isActive === false) {
        await revokeAllUserTokens(app.prisma, member.userId);
      }

      const baseMeta = {
        organizationId: member.organization.id,
        organizationName: member.organization.name,
        userId: member.user.id,
        userEmail: member.user.email,
      };

      if (data.isActive !== undefined) {
        await recordAdminAction({
          prisma: app.prisma,
          actor: request.currentUser!,
          action: data.isActive ? "MEMBER_REINSTATE" : "MEMBER_REVOKE",
          entityType: "ORGANIZATION_MEMBER",
          entityId: member.id,
          metadata: {
            ...baseMeta,
            previousIsActive: member.isActive,
            newIsActive: data.isActive,
          },
          log: request.log,
        });
      }

      if (roleChanged) {
        const adminFlipped = targetIsOrgAdmin !== member.isOrgAdmin;
        await recordAdminAction({
          prisma: app.prisma,
          actor: request.currentUser!,
          // Preserve the grant/revoke actions when campus-admin status flips;
          // a pure faculty-tier change (no admin flip) is its own action.
          action: adminFlipped
            ? targetIsOrgAdmin
              ? "ORG_ADMIN_GRANT"
              : "ORG_ADMIN_REVOKE"
            : "ORG_ROLE_CHANGE",
          entityType: "ORGANIZATION_MEMBER",
          entityId: member.id,
          metadata: {
            ...baseMeta,
            previousOrgRole: member.orgRole,
            newOrgRole: targetRole,
            previousIsOrgAdmin: member.isOrgAdmin,
            newIsOrgAdmin: targetIsOrgAdmin,
          },
          log: request.log,
        });
      }

      return reply.send({
        success: true,
        member: {
          id: updated.id,
          isActive: updated.isActive,
          isOrgAdmin: updated.isOrgAdmin,
          orgRole: updated.orgRole,
          user: member.user,
        },
      });
    }
  );
}
