import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { JWTPayload } from "../types/index.js";

export type AdminAction =
  | "ORG_CREATE"
  | "ORG_UPDATE"
  | "STUDENT_ADD"
  | "STUDENT_BULK_ADD"
  | "STUDENT_REMOVE"
  | "MEMBER_REVOKE"
  | "MEMBER_REINSTATE"
  | "ORG_ADMIN_BULK_ADD"
  | "ORG_ADMIN_GRANT"
  | "ORG_ADMIN_REVOKE"
  | "PREMIUM_GRANT"
  | "PREMIUM_REVOKE"
  | "USER_SUSPEND"
  | "USER_REINSTATE"
  | "SUBSCRIPTION_CANCEL";

export type AdminEntityType =
  | "ORGANIZATION"
  | "PRELOADED_STUDENT"
  | "ORGANIZATION_MEMBER"
  | "USER";

export interface RecordAdminActionInput {
  prisma: PrismaClient;
  actor: JWTPayload;
  action: AdminAction;
  entityType: AdminEntityType;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
  log?: FastifyBaseLogger;
}

// Audit logging is best-effort: a logging failure must never block the
// admin action that triggered it. We swallow errors here and surface them
// to the request logger so ops can still notice via existing log pipelines.
export async function recordAdminAction({
  prisma,
  actor,
  action,
  entityType,
  entityId,
  metadata,
  log,
}: RecordAdminActionInput): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        actorId: actor.userId,
        actorEmail: actor.email,
        action,
        entityType,
        entityId: entityId ?? null,
        metadata: (metadata as object | undefined) ?? undefined,
      },
    });
  } catch (err) {
    log?.error(
      { err, action, entityType, entityId, actorId: actor.userId },
      "Failed to write admin audit log"
    );
  }
}
