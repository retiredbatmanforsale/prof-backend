// Proctoring integrity engine (Phase 3). The SERVER is authoritative for the
// warning budget and termination — the client only reports raw signals.
//
// Warnable (consume the budget): TAB_SWITCH, COPY_ATTEMPT, PASTE_ATTEMPT.
// Hard terminate (no warning, immediate): FULLSCREEN_EXIT, HIDDEN_TIMEOUT.
// Everything else (FOCUS_LOSS, CUT_ATTEMPT, CONTEXT_MENU, DRAG_DROP,
// FULLSCREEN_ENTER) is logged only. A tab-switch fires twice in browsers (blur +
// visibilitychange); the second tab-group event within DEDUPE_MS is recorded but
// NOT counted.

import { Prisma, type PrismaClient, type IntegrityEventType } from "@prisma/client";
import { autoFinalizeAttempt } from "./attemptLifecycle.js";
import type { autoGrade } from "./grading.js";

const WARNABLE = new Set<IntegrityEventType>(["TAB_SWITCH", "COPY_ATTEMPT", "PASTE_ATTEMPT"]);
// Immediate hard-terminate (no warning): leaving fullscreen, or tab hidden past the threshold.
const HARD_TERMINATE = new Set<IntegrityEventType>(["FULLSCREEN_EXIT", "HIDDEN_TIMEOUT"]);
const TAB_GROUP = new Set<IntegrityEventType>(["TAB_SWITCH", "FOCUS_LOSS"]);
const DEDUPE_MS = 1500;

export interface IntegrityResult {
  warningsIssued: number;
  remaining: number;
  terminated: boolean;
  action: "NONE" | "WARNED" | "AUTO_SUBMITTED";
}

function counterPatch(type: IntegrityEventType): Prisma.AssessmentIntegrityUpdateInput {
  switch (type) {
    case "TAB_SWITCH": return { tabSwitchCount: { increment: 1 } };
    case "FULLSCREEN_EXIT": return { fullscreenExitCount: { increment: 1 } };
    case "COPY_ATTEMPT": return { copyAttemptCount: { increment: 1 } };
    case "PASTE_ATTEMPT": return { pasteAttemptCount: { increment: 1 } };
    case "CONTEXT_MENU": return { contextMenuCount: { increment: 1 } };
    case "FOCUS_LOSS": return { focusLossCount: { increment: 1 } };
    default: return {};
  }
}

export async function recordIntegrityEvent(
  prisma: PrismaClient,
  args: {
    assessment: { id: string; maxWarnings: number | null; questions: Parameters<typeof autoGrade>[0]; durationMinutes: number | null; dueAt: Date | null };
    attempt: { id: string; userId: string; answers: unknown; status: string; startedAt: Date };
    type: IntegrityEventType;
    questionId?: string | null;
    clientTs?: string | null;
    meta?: unknown;
    ipAddress?: string | null;
    userAgent?: string | null;
    fingerprint?: string | null;
  }
): Promise<IntegrityResult> {
  const { assessment, attempt, type } = args;
  const maxWarnings = assessment.maxWarnings ?? 3;
  const now = new Date();

  // lazily create the 1:1 integrity row (snapshot maxWarnings + first device)
  let integ = await prisma.assessmentIntegrity.findUnique({ where: { attemptId: attempt.id } });
  if (!integ) {
    integ = await prisma.assessmentIntegrity.create({
      data: {
        attemptId: attempt.id, assessmentId: assessment.id, userId: attempt.userId,
        maxWarnings,
        firstIp: args.ipAddress ?? null, firstUserAgent: args.userAgent ?? null, firstFingerprint: args.fingerprint ?? null,
      },
    });
  }

  const remainingOf = (issued: number) => Math.max(0, integ!.maxWarnings - issued);

  // already terminated / attempt closed → no-op
  if (integ.terminated || attempt.status === "SUBMITTED" || attempt.status === "LOCKED") {
    return { warningsIssued: integ.warningsIssued, remaining: remainingOf(integ.warningsIssued), terminated: true, action: "NONE" };
  }

  // dedupe a tab-switch double event (blur + visibilitychange)
  let deduped = false;
  if (TAB_GROUP.has(type)) {
    const last = await prisma.assessmentEvent.findFirst({
      where: { attemptId: attempt.id, type: { in: [...TAB_GROUP] } },
      orderBy: { createdAt: "desc" },
    });
    if (last && now.getTime() - last.createdAt.getTime() < DEDUPE_MS) deduped = true;
  }

  const warnable = WARNABLE.has(type) && !deduped;
  const counter = deduped ? {} : counterPatch(type);

  // 1. always record the raw event (audit trail)
  await prisma.assessmentEvent.create({
    data: {
      attemptId: attempt.id, assessmentId: assessment.id, userId: attempt.userId,
      type, questionId: args.questionId ?? null, warnable,
      ipAddress: args.ipAddress ?? null, userAgent: args.userAgent ?? null, fingerprint: args.fingerprint ?? null,
      clientTs: args.clientTs ? new Date(args.clientTs) : null,
      meta: (args.meta ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });

  // 2. Hard-terminate signals (FULLSCREEN_EXIT, HIDDEN_TIMEOUT) → immediate auto-submit, no warning.
  if (HARD_TERMINATE.has(type)) {
    await prisma.assessmentIntegrity.update({
      where: { attemptId: attempt.id },
      data: { ...counter, terminated: true, terminatedReason: type, terminatedAt: now, lastEventAt: now },
    });
    await prisma.assessmentEvent.create({ data: { attemptId: attempt.id, assessmentId: assessment.id, userId: attempt.userId, type: "AUTO_SUBMIT", warnable: false, meta: { reason: type } } });
    await autoFinalizeAttempt(prisma, assessment, attempt);
    return { warningsIssued: integ.warningsIssued, remaining: 0, terminated: true, action: "AUTO_SUBMITTED" };
  }

  // 3. non-warnable (logged-only or deduped) → just bump the counter
  if (!warnable) {
    await prisma.assessmentIntegrity.update({ where: { attemptId: attempt.id }, data: { ...counter, lastEventAt: now } });
    return { warningsIssued: integ.warningsIssued, remaining: remainingOf(integ.warningsIssued), terminated: false, action: "NONE" };
  }

  // 4. warnable → warning++ ; at the budget → auto-submit
  const warningsIssued = integ.warningsIssued + 1;
  const reached = warningsIssued >= integ.maxWarnings;
  await prisma.assessmentIntegrity.update({
    where: { attemptId: attempt.id },
    data: {
      ...counter, warningsIssued, lastEventAt: now,
      ...(reached ? { terminated: true, terminatedReason: `MAX_WARNINGS_${type}`, terminatedAt: now } : {}),
    },
  });
  await prisma.assessmentEvent.create({ data: { attemptId: attempt.id, assessmentId: assessment.id, userId: attempt.userId, type: "WARNING_ISSUED", warnable: false, meta: { warningsIssued, trigger: type } } });

  if (reached) {
    await prisma.assessmentEvent.create({ data: { attemptId: attempt.id, assessmentId: assessment.id, userId: attempt.userId, type: "AUTO_SUBMIT", warnable: false, meta: { reason: "MAX_WARNINGS", trigger: type } } });
    await autoFinalizeAttempt(prisma, assessment, attempt);
    return { warningsIssued, remaining: 0, terminated: true, action: "AUTO_SUBMITTED" };
  }
  return { warningsIssued, remaining: integ.maxWarnings - warningsIssued, terminated: false, action: "WARNED" };
}
