import { OrgRole, type PrismaClient } from "@prisma/client";

// Phase 5 gradebook resolution. Returns RAW components + entries; Total % and
// letter grade are derived on the frontend (lib/university/gradebook.ts) so
// faculty and students share one source of truth.

export interface GradeComponentDTO {
  id: string;
  name: string;
  type: string;
  maxMarks: number;
  weight: number;
  assessmentId: string | null;
}

export interface GradeEntryDTO {
  componentId: string;
  score: number;
  source: string;
}

export interface StudentGradeRow {
  userId: string;
  name: string;
  email: string;
  entries: GradeEntryDTO[];
}

export interface SectionGradebook {
  sectionId: string;
  sectionName: string;
  components: GradeComponentDTO[];
  students: StudentGradeRow[];
}

function toComponentDTO(c: {
  id: string;
  name: string;
  type: string;
  maxMarks: number;
  weight: number;
  assessmentId: string | null;
}): GradeComponentDTO {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    maxMarks: c.maxMarks,
    weight: c.weight,
    assessmentId: c.assessmentId,
  };
}

/** Full gradebook for a cohort — components + every active student's entries. */
export async function resolveSectionGradebook(
  prisma: PrismaClient,
  sectionId: string
): Promise<SectionGradebook | null> {
  const section = await prisma.section.findUnique({
    where: { id: sectionId },
    select: {
      id: true,
      name: true,
      students: {
        where: { member: { isActive: true, orgRole: OrgRole.STUDENT } },
        select: {
          member: {
            select: { user: { select: { id: true, name: true, email: true } } },
          },
        },
      },
    },
  });
  if (!section) return null;

  const users = section.students.map((s) => s.member.user);
  const userIds = users.map((u) => u.id);

  const components = await prisma.gradeComponent.findMany({
    where: { sectionId },
    orderBy: { createdAt: "asc" },
  });
  const componentIds = components.map((c) => c.id);

  const entries =
    componentIds.length && userIds.length
      ? await prisma.gradeEntry.findMany({
          where: {
            componentId: { in: componentIds },
            studentId: { in: userIds },
          },
          select: { componentId: true, studentId: true, score: true, source: true },
        })
      : [];

  const byStudent = new Map<string, GradeEntryDTO[]>();
  for (const id of userIds) byStudent.set(id, []);
  for (const e of entries) {
    byStudent
      .get(e.studentId)
      ?.push({ componentId: e.componentId, score: e.score, source: e.source });
  }

  return {
    sectionId: section.id,
    sectionName: section.name,
    components: components.map(toComponentDTO),
    students: users.map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      entries: byStudent.get(u.id) ?? [],
    })),
  };
}

/** A single student's gradebook — their cohort's components + their own entries. */
export async function getStudentGradebook(
  prisma: PrismaClient,
  userId: string
): Promise<{ sectionName: string | null; components: GradeComponentDTO[]; entries: GradeEntryDTO[] }> {
  const membership = await prisma.sectionStudent.findFirst({
    where: { member: { userId } },
    select: { sectionId: true, section: { select: { name: true } } },
  });
  if (!membership) return { sectionName: null, components: [], entries: [] };

  const components = await prisma.gradeComponent.findMany({
    where: { sectionId: membership.sectionId },
    orderBy: { createdAt: "asc" },
  });
  const entries = await prisma.gradeEntry.findMany({
    where: {
      studentId: userId,
      componentId: { in: components.map((c) => c.id) },
    },
    select: { componentId: true, score: true, source: true },
  });

  return {
    sectionName: membership.section.name,
    components: components.map(toComponentDTO),
    entries: entries.map((e) => ({
      componentId: e.componentId,
      score: e.score,
      source: e.source,
    })),
  };
}

/**
 * AUTO sync: for AUTO components linked to an assessment, populate entries from
 * that assessment's attempt scores. The assessment-grading engine doesn't exist
 * yet (AssessmentAttempt carries no score), so today this finds nothing to sync
 * and reports it — faculty enter those components manually for now. When scoring
 * lands, this is the single place that fills AUTO grades. Returns how many
 * entries were written and how many components are still awaiting scoring.
 */
export async function syncAssessmentGrades(
  prisma: PrismaClient,
  sectionId: string
): Promise<{ synced: number; pending: number; message: string }> {
  const autoComponents = await prisma.gradeComponent.findMany({
    where: { sectionId, assessmentId: { not: null } },
    select: { id: true, assessmentId: true, maxMarks: true },
  });
  if (autoComponents.length === 0) {
    return { synced: 0, pending: 0, message: "No AUTO (assessment-linked) components to sync." };
  }

  let synced = 0;
  let pending = 0;

  for (const c of autoComponents) {
    // Fully-graded attempts only — pending-review attempts wait for finalize.
    const attempts = await prisma.assessmentAttempt.findMany({
      where: {
        assessmentId: c.assessmentId!,
        status: "SUBMITTED",
        gradedAt: { not: null },
        pendingReview: false,
      },
      select: { userId: true, score: true, maxScore: true },
    });

    // Count attempts still awaiting review (so faculty know what's outstanding).
    pending += await prisma.assessmentAttempt.count({
      where: { assessmentId: c.assessmentId!, status: "SUBMITTED", pendingReview: true },
    });

    for (const at of attempts) {
      const ratio = at.maxScore && at.maxScore > 0 ? (at.score ?? 0) / at.maxScore : 0;
      const scaled = Math.round(ratio * c.maxMarks * 100) / 100;
      const existing = await prisma.gradeEntry.findUnique({
        where: { componentId_studentId: { componentId: c.id, studentId: at.userId } },
        select: { source: true },
      });
      if (existing && existing.source === "MANUAL") continue; // don't clobber overrides
      await prisma.gradeEntry.upsert({
        where: { componentId_studentId: { componentId: c.id, studentId: at.userId } },
        create: { componentId: c.id, studentId: at.userId, score: scaled, source: "AUTO", enteredByMemberId: null },
        update: { score: scaled, source: "AUTO" },
      });
      synced += 1;
    }
  }

  return {
    synced,
    pending,
    message:
      synced > 0
        ? `Synced ${synced} graded attempt score(s) into the gradebook.${pending ? ` ${pending} attempt(s) still awaiting review.` : ""}`
        : pending > 0
        ? `No graded attempts yet — ${pending} awaiting review.`
        : "No submitted attempts to sync.",
  };
}
