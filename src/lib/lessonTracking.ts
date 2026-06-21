import { AssessmentStatus, OrgRole, type PrismaClient } from "@prisma/client";

/**
 * Phase 3 faculty visibility: raw per-student lesson + practice facts for a
 * section. This intentionally returns RAW facts (which lessons completed, which
 * problems solved, time spent) and does NOT compute the weighted course % — the
 * weights live in the frontend curriculum metadata, so the faculty UI and the
 * student roadmap derive the percentage from the same single source.
 */

export interface StudentLessonTracking {
  userId: string;
  name: string;
  email: string;
  completedLessonIds: string[];
  inProgressLessonIds: string[];
  /** Most recently active lesson that isn't completed (best guess at "current"). */
  currentLessonId: string | null;
  completedCount: number;
  attemptedProblemSlugs: string[];
  solvedProblemSlugs: string[];
  solvedCount: number;
  attemptedCount: number;
  totalTimeSeconds: number;
  lastActiveAt: string | null;
  /** Phase 4: how many of the cohort's published assessments this student
   *  ATTEMPTED (presence of an AssessmentAttempt — grading irrelevant). */
  assessmentsAttempted: number;
}

export interface SectionLessonTracking {
  sectionId: string;
  sectionName: string;
  students: StudentLessonTracking[];
  /** Phase 4: published assessments owned by this cohort (attendance denominator). */
  assessmentsTotal: number;
}

export async function computeSectionLessonTracking(
  prisma: PrismaClient,
  sectionId: string
): Promise<SectionLessonTracking | null> {
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

  // Published assessments OWNED by this cohort (Phase 2 ownership = sectionId).
  // Presence of an attempt against one of these = assessment participation.
  const publishedAssessments = await prisma.assessment.findMany({
    where: { sectionId: section.id, status: AssessmentStatus.PUBLISHED },
    select: { id: true },
  });
  const assessmentsTotal = publishedAssessments.length;
  const assessmentIds = publishedAssessments.map((a) => a.id);

  if (userIds.length === 0) {
    return {
      sectionId: section.id,
      sectionName: section.name,
      students: [],
      assessmentsTotal,
    };
  }

  // Batched reads cover the whole cohort — no per-student round-trips.
  const [progressRows, practiceRows, attemptRows] = await Promise.all([
    prisma.lessonProgress.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        lessonId: true,
        status: true,
        completedAt: true,
        timeSpentSeconds: true,
        lastActiveAt: true,
        updatedAt: true,
      },
    }),
    prisma.practiceAttempt.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, problemSlug: true, solved: true },
    }),
    // Attempt PRESENCE only — any status counts (don't wait for grading).
    assessmentIds.length > 0
      ? prisma.assessmentAttempt.findMany({
          where: { userId: { in: userIds }, assessmentId: { in: assessmentIds } },
          select: { userId: true },
        })
      : Promise.resolve([] as { userId: string }[]),
  ]);

  const attemptsByUser = new Map<string, number>();
  for (const a of attemptRows) {
    attemptsByUser.set(a.userId, (attemptsByUser.get(a.userId) ?? 0) + 1);
  }

  type Acc = {
    completed: string[];
    inProgress: { lessonId: string; at: Date }[];
    timeSpent: number;
    lastActive: Date | null;
    attempted: string[];
    solved: string[];
  };
  const byUser = new Map<string, Acc>();
  for (const id of userIds) {
    byUser.set(id, {
      completed: [],
      inProgress: [],
      timeSpent: 0,
      lastActive: null,
      attempted: [],
      solved: [],
    });
  }

  for (const r of progressRows) {
    const acc = byUser.get(r.userId);
    if (!acc) continue;
    acc.timeSpent += r.timeSpentSeconds ?? 0;
    const active = r.lastActiveAt ?? r.updatedAt;
    if (active && (!acc.lastActive || active > acc.lastActive)) acc.lastActive = active;
    if (r.completedAt || r.status === "READ" || r.status === "MASTERED") {
      acc.completed.push(r.lessonId);
    } else {
      acc.inProgress.push({ lessonId: r.lessonId, at: active ?? r.updatedAt });
    }
  }

  for (const p of practiceRows) {
    const acc = byUser.get(p.userId);
    if (!acc) continue;
    acc.attempted.push(p.problemSlug);
    if (p.solved) acc.solved.push(p.problemSlug);
  }

  const students: StudentLessonTracking[] = users.map((u) => {
    const acc = byUser.get(u.id)!;
    // "Current" lesson = most recently active in-progress lesson.
    const current = acc.inProgress
      .slice()
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      completedLessonIds: acc.completed,
      inProgressLessonIds: acc.inProgress.map((x) => x.lessonId),
      currentLessonId: current?.lessonId ?? null,
      completedCount: acc.completed.length,
      attemptedProblemSlugs: acc.attempted,
      solvedProblemSlugs: acc.solved,
      solvedCount: acc.solved.length,
      attemptedCount: acc.attempted.length,
      totalTimeSeconds: acc.timeSpent,
      lastActiveAt: acc.lastActive ? acc.lastActive.toISOString() : null,
      assessmentsAttempted: attemptsByUser.get(u.id) ?? 0,
    };
  });

  return {
    sectionId: section.id,
    sectionName: section.name,
    students,
    assessmentsTotal,
  };
}

/**
 * Phase 4: a single student's assessment participation — published assessments
 * in THEIR cohort vs. how many they attempted (presence only). Drives the
 * student's own Attendance % on their dashboard. Returns zeros for learners
 * with no cohort (independent users).
 */
export async function getStudentAssessmentParticipation(
  prisma: PrismaClient,
  userId: string
): Promise<{ attempted: number; total: number }> {
  const membership = await prisma.sectionStudent.findFirst({
    where: { member: { userId } },
    select: { sectionId: true },
  });
  if (!membership) return { attempted: 0, total: 0 };

  const published = await prisma.assessment.findMany({
    where: { sectionId: membership.sectionId, status: AssessmentStatus.PUBLISHED },
    select: { id: true },
  });
  const total = published.length;
  if (total === 0) return { attempted: 0, total: 0 };

  const attempted = await prisma.assessmentAttempt.count({
    where: { userId, assessmentId: { in: published.map((a) => a.id) } },
  });
  return { attempted, total };
}
