import type { FastifyInstance } from "fastify";
import { parse } from "csv-parse/sync";
import { addStudentSchema } from "../../schemas/admin.js";
import { generateToken } from "../../lib/tokens.js";
import { sendInvitationEmail } from "../../lib/email.js";

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

      return reply.send({ success: true });
    }
  );
}
