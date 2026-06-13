import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { requireOrgAdmin } from "../../hooks/orgAdmin.js";
import orgMetricsRoutes from "./metrics.js";
import orgSectionsRoutes from "./sections.js";
import orgMembersRoutes from "./members.js";

/**
 * Organization-admin surface (/org/*). Distinct from the platform-wide
 * /admin surface: every route here is scoped to the single organization the
 * caller administers, enforced by requireOrgAdmin (authoritative DB check).
 */
export default async function orgRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireOrgAdmin);

  await app.register(orgMetricsRoutes);
  await app.register(orgSectionsRoutes);
  await app.register(orgMembersRoutes);
}
