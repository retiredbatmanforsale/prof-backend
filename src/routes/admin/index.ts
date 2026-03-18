import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { requireAdmin } from "../../hooks/admin.js";
import organizationRoutes from "./organizations.js";
import studentRoutes from "./students.js";

export default async function adminRoutes(app: FastifyInstance) {
  // All admin routes require authentication + admin role
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireAdmin);

  await app.register(organizationRoutes);
  await app.register(studentRoutes);
}
