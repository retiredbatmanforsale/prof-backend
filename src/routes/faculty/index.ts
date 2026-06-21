import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { requireOrgAdmin } from "../../hooks/orgAdmin.js";
import orgMetricsRoutes from "../org/metrics.js";
import orgSectionsRoutes from "../org/sections.js";
import orgMembersRoutes from "../org/members.js";
import orgAssessmentRoutes from "../org/assessments.js";
import orgAnalyticsRoutes from "../org/analytics.js";
import orgGradesRoutes from "../org/grades.js";

/**
 * Phase 7 — unified Faculty surface (/faculty/*).
 *
 * The campus-admin and faculty dashboards are now ONE flat surface. These are
 * the former /org/* modules, reused verbatim (sections, members, assessments,
 * grades, analytics, metrics) and gated by requireOrgAdmin. The standalone /org
 * runtime surface is retired; only /admin (global) and /faculty remain.
 */
export default async function facultyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireOrgAdmin);

  await app.register(orgMetricsRoutes);
  await app.register(orgSectionsRoutes);
  await app.register(orgMembersRoutes);
  await app.register(orgAssessmentRoutes);
  await app.register(orgAnalyticsRoutes);
  await app.register(orgGradesRoutes);
}
