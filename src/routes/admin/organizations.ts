import type { FastifyInstance } from "fastify";
import {
  createOrganizationSchema,
  updateOrganizationSchema,
} from "../../schemas/admin.js";

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
      if (name !== undefined) data.name = name;
      if (emailDomains !== undefined) data.emailDomains = emailDomains;
      if (isActive !== undefined) data.isActive = isActive;
      if (accessStartDate !== undefined) {
        data.accessStartDate = accessStartDate
          ? new Date(accessStartDate)
          : null;
      }
      if (accessEndDate !== undefined) {
        data.accessEndDate = accessEndDate ? new Date(accessEndDate) : null;
      }

      const org = await app.prisma.organization.update({
        where: { id: request.params.id },
        data,
      });

      return reply.send({ success: true, organization: org });
    }
  );
}
