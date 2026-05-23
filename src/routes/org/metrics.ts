import type { FastifyInstance } from "fastify";
import { computeOrgMetrics } from "../../lib/orgMetrics.js";

export default async function orgMetricsRoutes(app: FastifyInstance) {
  // GET /org/metrics — consolidated learning metrics for the caller's
  // organization. Auth + org-admin guard are applied at the parent
  // (org/index.ts), which also resolves request.orgAdminContext.
  app.get(
    "/metrics",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const ctx = request.orgAdminContext!;
      const metrics = await computeOrgMetrics(
        app.prisma,
        ctx.organizationId,
        ctx.organizationName
      );
      return reply.send(metrics);
    }
  );
}
