import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { requireFaculty } from "../../hooks/faculty.js";
import facultySectionsRoutes from "./sections.js";

/**
 * Faculty surface (/faculty/*). The L2 tier of the university hierarchy: a
 * faculty/TA member sees only the sections (cohorts) assigned to them. Every
 * route is gated by requireFaculty (authoritative DB check) and scoped to the
 * caller's assigned sections. Campus admins use /org instead.
 */
export default async function facultyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireFaculty);

  await app.register(facultySectionsRoutes);
}
