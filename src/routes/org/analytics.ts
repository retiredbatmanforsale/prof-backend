import type { FastifyInstance } from "fastify";
import { AssessmentStatus, AttemptStatus, OrgRole } from "@prisma/client";
import { FACULTY_TIER_ROLES } from "../../lib/orgRole.js";

/**
 * Campus-admin analytics views (Faculty / Students / Live Monitoring) under
 * /org/*. Auth + org-admin guard applied at the parent. EVERY query is scoped
 * to ctx.organizationId — strictly no cross-org data. Pure aggregation over
 * real assessment_attempts; no proctoring, no grading.
 */
function parseState(raw: unknown): { currentQuestion: number; flaggedCount: number; answeredCount: number } {
  const s = (raw ?? {}) as { currentQuestion?: number; flaggedQuestions?: string[]; answers?: Record<string, unknown> };
  const answers = s.answers ?? {};
  const answeredCount = Object.values(answers).filter((v) =>
    Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : v != null
  ).length;
  return {
    currentQuestion: typeof s.currentQuestion === "number" ? s.currentQuestion : 0,
    flaggedCount: Array.isArray(s.flaggedQuestions) ? s.flaggedQuestions.length : 0,
    answeredCount,
  };
}
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : 0);

export default async function orgAnalyticsRoutes(app: FastifyInstance) {
  const rateLimit = { max: 60, timeWindow: "1 minute" } as const;
  const monitorLimit = { max: 240, timeWindow: "1 minute" } as const;

  // GET /org/faculty — per-faculty aggregates.
  app.get("/faculty", { config: { rateLimit } }, async (request, reply) => {
    const ctx = request.orgAdminContext!;
    const orgId = ctx.organizationId;
    const now = new Date();

    const [members, sectionStudents, attempts] = await Promise.all([
      app.prisma.organizationMember.findMany({
        where: { organizationId: orgId, orgRole: { in: [...FACULTY_TIER_ROLES] } },
        select: {
          id: true,
          orgRole: true,
          user: { select: { name: true, email: true } },
          sectionAssignments: { select: { sectionId: true } },
          assessmentsAuthored: { select: { id: true, status: true, opensAt: true, dueAt: true } },
        },
      }),
      app.prisma.sectionStudent.findMany({
        where: { section: { organizationId: orgId } },
        select: { sectionId: true, organizationMemberId: true },
      }),
      app.prisma.assessmentAttempt.findMany({
        where: { assessment: { organizationId: orgId } },
        select: { assessmentId: true, userId: true, status: true },
      }),
    ]);

    // sectionId -> set of student member ids
    const studentsBySection = new Map<string, Set<string>>();
    for (const ss of sectionStudents) {
      if (!studentsBySection.has(ss.sectionId)) studentsBySection.set(ss.sectionId, new Set());
      studentsBySection.get(ss.sectionId)!.add(ss.organizationMemberId);
    }
    // assessmentId -> attempts
    const attemptsByAssessment = new Map<string, typeof attempts>();
    for (const a of attempts) {
      if (!attemptsByAssessment.has(a.assessmentId)) attemptsByAssessment.set(a.assessmentId, []);
      attemptsByAssessment.get(a.assessmentId)!.push(a);
    }

    const isOpen = (s: { status: AssessmentStatus; opensAt: Date | null; dueAt: Date | null }) =>
      s.status === AssessmentStatus.PUBLISHED &&
      (!s.opensAt || s.opensAt <= now) &&
      (!s.dueAt || s.dueAt >= now);

    const faculty = members.map((m) => {
      const sectionIds = m.sectionAssignments.map((x) => x.sectionId);
      const studentSet = new Set<string>();
      for (const sid of sectionIds) studentsBySection.get(sid)?.forEach((x) => studentSet.add(x));
      const studentsAssigned = studentSet.size;

      const published = m.assessmentsAuthored.filter((a) => a.status === AssessmentStatus.PUBLISHED);
      const myAttempts = m.assessmentsAuthored.flatMap((a) => attemptsByAssessment.get(a.id) ?? []);
      const started = myAttempts.length;
      const submitted = myAttempts.filter((a) => a.status === AttemptStatus.SUBMITTED).length;
      const locked = myAttempts.filter((a) => a.status === AttemptStatus.LOCKED).length;
      const expected = published.length * studentsAssigned;

      return {
        memberId: m.id,
        name: m.user.name || m.user.email,
        role: m.orgRole,
        sectionsAssigned: sectionIds.length,
        assessmentsCreated: m.assessmentsAuthored.length,
        activeAssessments: m.assessmentsAuthored.filter(isOpen).length,
        studentsAssigned,
        lockedAttempts: locked,
        completionPct: pct(submitted, started),
        engagementPct: pct(started, expected),
      };
    });

    faculty.sort((a, b) => b.assessmentsCreated - a.assessmentsCreated);
    return reply.send({ organizationName: ctx.organizationName, faculty });
  });

  // GET /org/students — per-student aggregates.
  app.get("/students", { config: { rateLimit } }, async (request, reply) => {
    const ctx = request.orgAdminContext!;
    const orgId = ctx.organizationId;

    const [students, attempts] = await Promise.all([
      app.prisma.organizationMember.findMany({
        where: { organizationId: orgId, orgRole: OrgRole.STUDENT },
        select: {
          id: true,
          userId: true,
          user: { select: { name: true, email: true } },
          sectionStudentOf: { select: { section: { select: { name: true } } } },
        },
      }),
      app.prisma.assessmentAttempt.findMany({
        where: { assessment: { organizationId: orgId } },
        select: { userId: true, status: true },
      }),
    ]);

    const byUser = new Map<string, typeof attempts>();
    for (const a of attempts) {
      if (!byUser.has(a.userId)) byUser.set(a.userId, []);
      byUser.get(a.userId)!.push(a);
    }

    const rows = students.map((s) => {
      const mine = byUser.get(s.userId) ?? [];
      const started = mine.length;
      const submitted = mine.filter((a) => a.status === AttemptStatus.SUBMITTED).length;
      const locked = mine.filter((a) => a.status === AttemptStatus.LOCKED).length;
      return {
        name: s.user.name || s.user.email,
        sections: s.sectionStudentOf.map((x) => x.section.name),
        started,
        submitted,
        locked,
        totalAttempts: started,
        completionPct: pct(submitted, started),
      };
    });

    rows.sort((a, b) => b.totalAttempts - a.totalAttempts || a.name.localeCompare(b.name));
    return reply.send({ organizationName: ctx.organizationName, students: rows });
  });

  // GET /org/monitoring — live IN_PROGRESS attempts (status-only, no proctoring).
  app.get("/monitoring", { config: { rateLimit: monitorLimit } }, async (request, reply) => {
    const ctx = request.orgAdminContext!;
    const now = Date.now();
    const live = await app.prisma.assessmentAttempt.findMany({
      where: { status: AttemptStatus.IN_PROGRESS, assessment: { organizationId: ctx.organizationId } },
      select: {
        startedAt: true,
        updatedAt: true,
        answers: true,
        user: { select: { name: true, email: true } },
        assessment: { select: { title: true } },
      },
      orderBy: { updatedAt: "desc" },
    });

    const rows = live.map((a) => {
      const st = parseState(a.answers);
      const idleMs = now - a.updatedAt.getTime();
      const health = idleMs < 120_000 ? "active" : idleMs < 600_000 ? "idle" : "suspicious";
      return {
        student: a.user.name || a.user.email,
        assessment: a.assessment.title,
        currentQuestion: st.currentQuestion,
        flaggedCount: st.flaggedCount,
        answeredCount: st.answeredCount,
        lastAutosaveAt: a.updatedAt.toISOString(),
        startedAt: a.startedAt.toISOString(),
        runningMs: now - a.startedAt.getTime(),
        idleMs,
        health,
      };
    });

    return reply.send({
      organizationName: ctx.organizationName,
      activeStudents: rows.length,
      activeAssessments: new Set(rows.map((r) => r.assessment)).size,
      attempts: rows,
      serverTime: new Date(now).toISOString(),
    });
  });
}
