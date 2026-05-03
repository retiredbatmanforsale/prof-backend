import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

export default async function adminWaitlistRoutes(app: FastifyInstance) {
  // GET /admin/waitlist — list entries with pagination, source filter,
  // case-insensitive search across email/name/organization. Auth + admin
  // guard inherited from admin/index.ts.
  app.get(
    "/waitlist",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const q = request.query as {
        source?: string;
        search?: string;
        limit?: string;
        offset?: string;
      };

      const limit = Math.min(
        Math.max(parseInt(q.limit ?? "", 10) || DEFAULT_PAGE_SIZE, 1),
        MAX_PAGE_SIZE
      );
      const offset = Math.max(parseInt(q.offset ?? "", 10) || 0, 0);
      const search = (q.search ?? "").trim();
      const source = (q.source ?? "").trim();

      const conditions: Prisma.WaitlistEntryWhereInput[] = [];
      if (source) conditions.push({ source });
      if (search) {
        conditions.push({
          OR: [
            { email: { contains: search, mode: "insensitive" as const } },
            { name: { contains: search, mode: "insensitive" as const } },
            {
              organization: { contains: search, mode: "insensitive" as const },
            },
          ],
        });
      }
      const where: Prisma.WaitlistEntryWhereInput =
        conditions.length > 0 ? { AND: conditions } : {};

      // Count by source for the KPI strip — single groupBy hits the same
      // index we built on the source column. Total count is derived from
      // summing rather than a separate query.
      const [rows, total, bySource] = await Promise.all([
        app.prisma.waitlistEntry.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: limit,
          select: {
            id: true,
            email: true,
            source: true,
            name: true,
            phone: true,
            organization: true,
            role: true,
            referrer: true,
            utmSource: true,
            utmMedium: true,
            utmCampaign: true,
            ipAddress: true,
            createdAt: true,
            lastSeenAt: true,
            convertedAt: true,
          },
        }),
        app.prisma.waitlistEntry.count({ where }),
        app.prisma.waitlistEntry.groupBy({
          by: ["source"],
          _count: { source: true },
          orderBy: { _count: { source: "desc" } },
        }),
      ]);

      return reply.send({
        total,
        limit,
        offset,
        entries: rows,
        bySource: bySource.map((g) => ({
          source: g.source,
          count: g._count.source,
        })),
      });
    }
  );
}
