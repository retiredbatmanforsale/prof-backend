import type { FastifyInstance } from "fastify";
import { runExpiryNoticeJob } from "../../lib/expiry-notices.js";

export default async function auditRoutes(app: FastifyInstance) {
  // POST /jobs/expiry-notices — Run the institution expiry warning job.
  // Idempotent: a unique row per (member, kind, targetEndDate) ensures
  // a re-run never double-sends. Wire this to your platform's cron.
  app.post(
    "/jobs/expiry-notices",
    {
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const result = await runExpiryNoticeJob(app.prisma, request.log);
      return reply.send({ success: true, ...result });
    }
  );


  // GET /audit-log — Recent admin actions. Filter by entityType/entityId
  // to scope to a specific organization or member.
  app.get<{
    Querystring: {
      entityType?: string;
      entityId?: string;
      actorId?: string;
      limit?: string;
    };
  }>(
    "/audit-log",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { entityType, entityId, actorId } = request.query;
      const rawLimit = parseInt(request.query.limit ?? "100", 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 500)
        : 100;

      const entries = await app.prisma.adminAuditLog.findMany({
        where: {
          ...(entityType ? { entityType } : {}),
          ...(entityId ? { entityId } : {}),
          ...(actorId ? { actorId } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      return reply.send({ entries });
    }
  );
}
