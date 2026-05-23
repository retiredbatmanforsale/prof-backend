import type { PrismaClient } from "@prisma/client";
import { COURSES, KNOWN_LESSON_IDS, TOTAL_LESSONS } from "./courseManifest.js";

/**
 * Consolidated learning metrics for one organization, computed entirely from
 * data we already persist: LessonProgress (read/mastered) and QuizAttempt.
 *
 * Cohort = active organization members who are NOT org admins. The admin
 * viewing the dashboard is staff, not a learner, so counting their (empty)
 * progress would drag every average down.
 *
 * Three headline metrics, each reported as both an average and a median so an
 * admin can see whether the mean is skewed by a few highly-active learners:
 *   - daysActive      distinct UTC days with any lesson or quiz activity
 *   - completionPct   % of all known lessons the learner has read/mastered
 *   - quizzesCompleted number of submitted quizzes (one row per lesson quiz)
 *
 * Per-member rows also carry coursesCompleted (courses where every lesson is
 * read/mastered) for a more granular view in the table.
 *
 * "Time spent" and "practice problems" are intentionally excluded — neither
 * is recorded server-side today.
 */

export interface OrgMemberMetrics {
  userId: string;
  name: string;
  email: string;
  daysActive: number;
  completionPct: number;
  coursesCompleted: number;
  quizzesCompleted: number;
  lastActiveAt: string | null;
}

interface MetricTriplet {
  daysActive: number;
  completionPct: number;
  quizzesCompleted: number;
}

export interface OrgMetrics {
  organizationId: string;
  organizationName: string;
  memberCount: number;
  // Mean and median sit side by side so the dashboard can render a direct
  // comparison block per metric.
  averages: MetricTriplet;
  medians: MetricTriplet;
  totals: {
    daysActive: number;
    coursesCompleted: number;
    quizzesCompleted: number;
  };
  members: OrgMemberMetrics[];
  totalCourses: number;
  totalLessons: number;
  generatedAt: string;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Round to one decimal so the UI shows e.g. 3.4 not 3.39999. */
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Mean of a numeric list, 0 for an empty list (avoids divide-by-zero). */
const mean = (xs: number[]) =>
  xs.length === 0 ? 0 : round1(xs.reduce((a, b) => a + b, 0) / xs.length);

/** Median of a numeric list, 0 for an empty list. */
const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return round1(value);
};

export async function computeOrgMetrics(
  prisma: PrismaClient,
  organizationId: string,
  organizationName: string
): Promise<OrgMetrics> {
  // 1. Resolve the learner cohort (active, non-admin members).
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, isActive: true, isOrgAdmin: false },
    select: {
      user: { select: { id: true, name: true, email: true } },
    },
  });

  const userIds = members.map((m) => m.user.id);

  // Empty cohort — return zeroed shape rather than dividing by zero.
  if (userIds.length === 0) {
    const zero: MetricTriplet = {
      daysActive: 0,
      completionPct: 0,
      quizzesCompleted: 0,
    };
    return {
      organizationId,
      organizationName,
      memberCount: 0,
      averages: zero,
      medians: { ...zero },
      totals: { daysActive: 0, coursesCompleted: 0, quizzesCompleted: 0 },
      members: [],
      totalCourses: COURSES.length,
      totalLessons: TOTAL_LESSONS,
      generatedAt: new Date().toISOString(),
    };
  }

  // 2. Two batched reads cover every learner — no per-user round-trips.
  const [progressRows, quizRows] = await Promise.all([
    prisma.lessonProgress.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        lessonId: true,
        status: true,
        readAt: true,
        updatedAt: true,
      },
    }),
    prisma.quizAttempt.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, updatedAt: true },
    }),
  ]);

  // 3. Index activity per user.
  const readLessonsByUser = new Map<string, Set<string>>();
  const activeDaysByUser = new Map<string, Set<string>>();
  const lastActiveByUser = new Map<string, Date>();
  const quizCountByUser = new Map<string, number>();

  const touchActiveDay = (userId: string, ts: Date) => {
    let set = activeDaysByUser.get(userId);
    if (!set) {
      set = new Set();
      activeDaysByUser.set(userId, set);
    }
    set.add(dayKey(ts));
    const last = lastActiveByUser.get(userId);
    if (!last || ts > last) lastActiveByUser.set(userId, ts);
  };

  for (const r of progressRows) {
    if (r.status === "READ" || r.status === "MASTERED") {
      let set = readLessonsByUser.get(r.userId);
      if (!set) {
        set = new Set();
        readLessonsByUser.set(r.userId, set);
      }
      set.add(r.lessonId);
    }
    touchActiveDay(r.userId, r.readAt ?? r.updatedAt);
  }

  for (const q of quizRows) {
    touchActiveDay(q.userId, q.updatedAt);
    quizCountByUser.set(q.userId, (quizCountByUser.get(q.userId) ?? 0) + 1);
  }

  // 4. Per-member rollup.
  const memberMetrics: OrgMemberMetrics[] = members.map(({ user }) => {
    const read = readLessonsByUser.get(user.id) ?? new Set<string>();

    // Completion % is over the known curriculum only — legacy/renamed slugs
    // a learner happened to read don't count toward (or inflate) the total.
    let readKnown = 0;
    for (const lid of read) {
      if (KNOWN_LESSON_IDS.has(lid)) readKnown += 1;
    }
    const completionPct =
      TOTAL_LESSONS > 0 ? round1((readKnown / TOTAL_LESSONS) * 100) : 0;

    let coursesCompleted = 0;
    for (const c of COURSES) {
      if (c.lessons.length > 0 && c.lessons.every((lid) => read.has(lid))) {
        coursesCompleted += 1;
      }
    }
    const last = lastActiveByUser.get(user.id);
    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      daysActive: activeDaysByUser.get(user.id)?.size ?? 0,
      completionPct,
      coursesCompleted,
      quizzesCompleted: quizCountByUser.get(user.id) ?? 0,
      lastActiveAt: last ? last.toISOString() : null,
    };
  });

  // 5. Aggregate. Build the per-metric arrays once, then derive mean + median.
  const daysActiveArr = memberMetrics.map((m) => m.daysActive);
  const completionArr = memberMetrics.map((m) => m.completionPct);
  const quizzesArr = memberMetrics.map((m) => m.quizzesCompleted);

  const totals = memberMetrics.reduce(
    (acc, m) => {
      acc.daysActive += m.daysActive;
      acc.coursesCompleted += m.coursesCompleted;
      acc.quizzesCompleted += m.quizzesCompleted;
      return acc;
    },
    { daysActive: 0, coursesCompleted: 0, quizzesCompleted: 0 }
  );

  // Sort the table most-engaged first so admins see active learners on top.
  memberMetrics.sort(
    (a, b) =>
      b.completionPct - a.completionPct ||
      b.quizzesCompleted - a.quizzesCompleted ||
      b.daysActive - a.daysActive
  );

  return {
    organizationId,
    organizationName,
    memberCount: memberMetrics.length,
    averages: {
      daysActive: mean(daysActiveArr),
      completionPct: mean(completionArr),
      quizzesCompleted: mean(quizzesArr),
    },
    medians: {
      daysActive: median(daysActiveArr),
      completionPct: median(completionArr),
      quizzesCompleted: median(quizzesArr),
    },
    totals,
    members: memberMetrics,
    totalCourses: COURSES.length,
    totalLessons: TOTAL_LESSONS,
    generatedAt: new Date().toISOString(),
  };
}
