import type { FastifyRequest, FastifyReply } from "fastify";
import { requireFaculty } from "./faculty.js";

/**
 * DEPRECATED — kept only so any lingering import keeps compiling. Under the flat
 * hierarchy there is no separate campus-admin gate: the org dashboard is open to
 * all staff via `requireFaculty`. This now delegates to it verbatim (same
 * orgAdminContext, same ?asOrg= platform-admin path), so nothing branches on
 * CAMPUS_ADMIN at runtime anymore. New code should import `requireFaculty`.
 */
export async function requireOrgAdmin(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return requireFaculty(request, reply);
}
