import type { FastifyInstance } from "fastify";
import { OrgRole } from "@prisma/client";
import { parse } from "csv-parse/sync";
import { generateToken } from "../../lib/tokens.js";
import { sendInvitationEmail } from "../../lib/email.js";
import { recordAdminAction } from "../../lib/audit.js";

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Map free-text role labels to a faculty-tier OrgRole. Defaults to FACULTY.
function normalizeFacultyRole(raw: string | undefined): OrgRole {
  const r = (raw ?? "").toLowerCase().trim();
  if (r === "ta" || r === "teaching assistant") return OrgRole.TA;
  if (r === "lab" || r === "lab assistant" || r === "lab_assistant")
    return OrgRole.LAB_ASSISTANT;
  return OrgRole.FACULTY;
}

/**
 * POST /admin/organizations/:orgId/staff/bulk — CSV upload of teaching staff
 * (faculty / lab assistants / TAs). Header (case-insensitive): name, email
 * [, role]. Each email is preloaded with the faculty-tier orgRole so that on
 * claim the resulting OrganizationMember is that tier (and can be assigned to
 * sections). Already-joined people are updated in place; otherwise an invite
 * is (re)issued. Mirrors the admins/bulk flow (in students.ts) but sets a
 * faculty tier instead of CAMPUS_ADMIN.
 */
export default async function staffRoutes(app: FastifyInstance) {
  app.post<{ Params: { orgId: string } }>(
    "/organizations/:orgId/staff/bulk",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
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
      const csvContent = (await file.toBuffer()).toString("utf-8");

      let records: Array<Record<string, string>>;
      try {
        records = parse(csvContent, {
          columns: (header: string[]) =>
            header.map((h) => h.trim().toLowerCase()),
          skip_empty_lines: true,
          trim: true,
        });
      } catch {
        return reply.status(400).send({
          error: "Invalid CSV. Expected columns: name, email[, role]",
        });
      }
      if (records.length > 1000) {
        return reply
          .status(400)
          .send({ error: "CSV file exceeds maximum of 1,000 rows" });
      }

      const results = { invited: 0, promoted: 0, errors: [] as string[] };

      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const email = (row.email || "").toLowerCase().trim();
        const name = (row.name || "").trim() || null;
        const orgRole = normalizeFacultyRole(row.role);

        if (!email || !emailRegex.test(email)) {
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
              name,
              organizationId: org.id,
              isOrgAdmin: false,
              orgRole,
            },
            update: { orgRole, ...(name ? { name } : {}) },
          });

          // Already joined? Set their tier on the live membership now.
          if (student.claimed && student.claimedByUserId) {
            await app.prisma.organizationMember.updateMany({
              where: {
                userId: student.claimedByUserId,
                organizationId: org.id,
              },
              data: { orgRole, isOrgAdmin: false },
            });
            results.promoted++;
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
            await sendInvitationEmail(email, org.name, rawToken);
          } catch (err) {
            app.log.error(err, `Failed to send invitation to ${email}`);
          }
          results.invited++;
        } catch (err) {
          app.log.error(err, `Failed to process staff ${email}`);
          results.errors.push(`Row ${i + 1}: Failed to process "${email}"`);
        }
      }

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "ORG_STAFF_BULK_ADD",
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
}
