import type { FastifyInstance } from "fastify";
import { OrgRole } from "@prisma/client";
import { acceptInviteSchema } from "../../schemas/admin.js";
import { hashPassword } from "../../lib/passwords.js";
import { linkPreloadedSectionOnClaim } from "../../lib/sections.js";

export default async function acceptInviteRoute(app: FastifyInstance) {
  // GET /auth/invite-info?token=xxx — Validate token and return info for form
  app.get(
    "/invite-info",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { token } = request.query as { token?: string };

      if (!token) {
        return reply.status(400).send({ error: "Token is required" });
      }

      const invitation = await app.prisma.invitationToken.findUnique({
        where: { token },
        include: {
          preloadedStudent: {
            include: {
              organization: { select: { name: true } },
            },
          },
        },
      });

      if (!invitation) {
        return reply.status(404).send({ error: "Invalid invitation link" });
      }

      if (invitation.used) {
        return reply.status(410).send({ error: "This invitation has already been used" });
      }

      if (invitation.expiresAt < new Date()) {
        return reply.status(410).send({ error: "This invitation has expired" });
      }

      const inviteOrg = await app.prisma.organization.findUnique({
        where: { id: invitation.preloadedStudent.organizationId },
        select: { isActive: true, accessEndDate: true },
      });
      const orgInactive = inviteOrg && !inviteOrg.isActive;
      const orgWindowEnded =
        inviteOrg?.accessEndDate && inviteOrg.accessEndDate < new Date();
      if (orgInactive || orgWindowEnded) {
        return reply.status(410).send({
          error:
            "This invitation is no longer valid — the organization's access window has ended.",
        });
      }

      return reply.send({
        email: invitation.preloadedStudent.email,
        name: invitation.preloadedStudent.name,
        organizationName: invitation.preloadedStudent.organization.name,
      });
    }
  );

  // POST /auth/accept-invite — Create account from invitation
  app.post(
    "/accept-invite",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = acceptInviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { token, name, password } = parsed.data;

      const invitation = await app.prisma.invitationToken.findUnique({
        where: { token },
        include: {
          preloadedStudent: {
            include: { organization: true },
          },
        },
      });

      if (!invitation) {
        return reply.status(404).send({ error: "Invalid invitation link" });
      }

      if (invitation.used) {
        return reply.status(410).send({ error: "This invitation has already been used" });
      }

      if (invitation.expiresAt < new Date()) {
        return reply.status(410).send({ error: "This invitation has expired" });
      }

      const { preloadedStudent } = invitation;
      const orgInactive = !preloadedStudent.organization.isActive;
      const orgWindowEnded =
        preloadedStudent.organization.accessEndDate &&
        preloadedStudent.organization.accessEndDate < new Date();
      if (orgInactive || orgWindowEnded) {
        return reply.status(410).send({
          error:
            "This invitation is no longer valid — the organization's access window has ended.",
        });
      }

      const hashedPw = await hashPassword(password);

      // Check if user already exists
      const existingUser = await app.prisma.user.findUnique({
        where: { email: preloadedStudent.email },
      });

      if (existingUser) {
        // Update existing user and grant membership
        await app.prisma.$transaction([
          app.prisma.user.update({
            where: { id: existingUser.id },
            data: {
              name,
              hashedPassword: hashedPw,
              emailVerified: existingUser.emailVerified || new Date(),
            },
          }),
          app.prisma.organizationMember.upsert({
            where: {
              userId_organizationId: {
                userId: existingUser.id,
                organizationId: preloadedStudent.organizationId,
              },
            },
            create: {
              userId: existingUser.id,
              organizationId: preloadedStudent.organizationId,
              isVerified: true,
              isActive: true,
              isOrgAdmin: preloadedStudent.isOrgAdmin,
              orgRole: preloadedStudent.orgRole,
            },
            // Escalate to org admin if the preloaded record says so; never
            // silently demote an existing admin on re-claim (keeps orgRole and
            // isOrgAdmin in lockstep).
            update: {
              isVerified: true,
              isActive: true,
              isOrgAdmin: preloadedStudent.isOrgAdmin || undefined,
              orgRole: preloadedStudent.isOrgAdmin ? OrgRole.CAMPUS_ADMIN : undefined,
            },
          }),
          app.prisma.preloadedStudent.update({
            where: { id: preloadedStudent.id },
            data: { claimed: true, claimedByUserId: existingUser.id },
          }),
          app.prisma.invitationToken.update({
            where: { id: invitation.id },
            data: { used: true },
          }),
        ]);
        // Materialize the cohort link a roster CSV recorded on the preload.
        await linkPreloadedSectionOnClaim(
          app.prisma,
          preloadedStudent,
          existingUser.id
        );
      } else {
        // Create new user + membership in a transaction
        let newUserId = "";
        await app.prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              name,
              email: preloadedStudent.email,
              hashedPassword: hashedPw,
              emailVerified: new Date(),
              role: "USER",
            },
          });
          newUserId = user.id;

          await tx.organizationMember.create({
            data: {
              userId: user.id,
              organizationId: preloadedStudent.organizationId,
              isVerified: true,
              isActive: true,
              isOrgAdmin: preloadedStudent.isOrgAdmin,
              orgRole: preloadedStudent.orgRole,
            },
          });

          await tx.preloadedStudent.update({
            where: { id: preloadedStudent.id },
            data: { claimed: true, claimedByUserId: user.id },
          });

          await tx.invitationToken.update({
            where: { id: invitation.id },
            data: { used: true },
          });
        });
        // Materialize the cohort link a roster CSV recorded on the preload.
        await linkPreloadedSectionOnClaim(
          app.prisma,
          preloadedStudent,
          newUserId
        );
      }

      return reply.send({ success: true });
    }
  );
}
