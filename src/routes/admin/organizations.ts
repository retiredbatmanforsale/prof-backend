import type { FastifyInstance } from "fastify";
import {
  createOrganizationSchema,
  updateOrganizationSchema,
} from "../../schemas/admin.js";
import { recordAdminAction } from "../../lib/audit.js";

export default async function organizationRoutes(app: FastifyInstance) {
  // POST /organizations — Create organization
  app.post(
    "/organizations",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = createOrganizationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { name, slug, emailDomains, accessStartDate, accessEndDate } =
        parsed.data;

      // Check slug uniqueness
      const existing = await app.prisma.organization.findUnique({
        where: { slug },
      });
      if (existing) {
        return reply.status(409).send({ error: "Slug already in use" });
      }

      const org = await app.prisma.organization.create({
        data: {
          name,
          slug,
          emailDomains,
          accessStartDate: accessStartDate
            ? new Date(accessStartDate)
            : null,
          accessEndDate: accessEndDate ? new Date(accessEndDate) : null,
        },
      });

      await recordAdminAction({
        prisma: app.prisma,
        actor: request.currentUser!,
        action: "ORG_CREATE",
        entityType: "ORGANIZATION",
        entityId: org.id,
        metadata: {
          name: org.name,
          slug: org.slug,
          emailDomains: org.emailDomains,
          accessStartDate: org.accessStartDate?.toISOString() ?? null,
          accessEndDate: org.accessEndDate?.toISOString() ?? null,
        },
        log: request.log,
      });

      return reply.status(201).send({ success: true, organization: org });
    }
  );

  // GET /organizations — List all orgs with counts
  app.get("/organizations", async (_request, reply) => {
    const orgs = await app.prisma.organization.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            members: true,
            preloadedStudents: true,
          },
        },
      },
    });

    return reply.send({ organizations: orgs });
  });

  // GET /organizations/:id — Org detail
  app.get<{ Params: { id: string } }>(
    "/organizations/:id",
    async (request, reply) => {
      const org = await app.prisma.organization.findUnique({
        where: { id: request.params.id },
        include: {
          members: {
            include: {
              user: { select: { id: true, name: true, email: true } },
            },
          },
          preloadedStudents: {
            orderBy: { createdAt: "desc" },
            include: {
              claimedBy: { select: { id: true, name: true, email: true } },
            },
          },
        },
      });

      if (!org) {
        return reply.status(404).send({ error: "Organization not found" });
      }

      return reply.send({ organization: org });
    }
  );

  // PATCH /organizations/:id — Update org
  app.patch<{ Params: { id: string } }>(
    "/organizations/:id",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = updateOrganizationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const existing = await app.prisma.organization.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) {
        return reply.status(404).send({ error: "Organization not found" });
      }

      const { name, emailDomains, isActive, accessStartDate, accessEndDate } =
        parsed.data;

      const data: Record<string, any> = {};
      const changes: Record<string, { from: unknown; to: unknown }> = {};

      const track = (field: string, from: unknown, to: unknown) => {
        if (JSON.stringify(from) !== JSON.stringify(to)) {
          changes[field] = { from, to };
        }
      };

      if (name !== undefined) {
        data.name = name;
        track("name", existing.name, name);
      }
      if (emailDomains !== undefined) {
        data.emailDomains = emailDomains;
        track("emailDomains", existing.emailDomains, emailDomains);
      }
      if (isActive !== undefined) {
        data.isActive = isActive;
        track("isActive", existing.isActive, isActive);
      }
      if (accessStartDate !== undefined) {
        const next = accessStartDate ? new Date(accessStartDate) : null;
        data.accessStartDate = next;
        track(
          "accessStartDate",
          existing.accessStartDate?.toISOString() ?? null,
          next?.toISOString() ?? null
        );
      }
      if (accessEndDate !== undefined) {
        const next = accessEndDate ? new Date(accessEndDate) : null;
        data.accessEndDate = next;
        track(
          "accessEndDate",
          existing.accessEndDate?.toISOString() ?? null,
          next?.toISOString() ?? null
        );
      }

      const org = await app.prisma.organization.update({
        where: { id: request.params.id },
        data,
      });

      if (Object.keys(changes).length > 0) {
        await recordAdminAction({
          prisma: app.prisma,
          actor: request.currentUser!,
          action: "ORG_UPDATE",
          entityType: "ORGANIZATION",
          entityId: org.id,
          metadata: { changes },
          log: request.log,
        });
      }

      return reply.send({ success: true, organization: org });
    }
  );
}
