import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { requireAdmin } from "../../hooks/admin.js";
import organizationRoutes from "./organizations.js";
import studentRoutes from "./students.js";
import refundRoutes from "./refunds.js";
import dashboardRoutes from "./dashboard.js";
import usersDirectoryRoutes from "./users.js";
import adminWaitlistRoutes from "./waitlist.js";
import auditRoutes from "./audit.js";

export default async function adminRoutes(app: FastifyInstance) {
  // All admin routes require authentication + admin role
  app.addHook("preHandler", authenticate);
  app.addHook("preHandler", requireAdmin);

  await app.register(organizationRoutes);
  await app.register(studentRoutes);
  await app.register(refundRoutes);
  await app.register(dashboardRoutes);
  await app.register(usersDirectoryRoutes);
  await app.register(adminWaitlistRoutes);
  await app.register(auditRoutes);
}
