import type { PrismaClient } from "@prisma/client";
import { COURSES, TOTAL_LESSONS } from "./courseManifest.js";

/**
 * Shared progress-summary computation.
 *
 * Single source of truth for both the authenticated dashboard
 * (`GET /progress/summary`, rendered on /account) and the public
 * shareable profile (`GET /progress/public/:userId`, rendered on
 * /u/<userId>). Both surfaces show the same numbers — they only differ
 * in which fields they expose to the client.
 *
 * Read-only: derives everything from LessonProgress + QuizAttempt +
 * User.createdAt. We intentionally do NOT read the UserStreak table here
 * (longestStreak / totalActiveDays are recomputed from raw activity) to
 * stay decoupled from the known prod schema drift on `user_streak`.
 */

export interface QuizScore {
  lessonId: string;
  pct: number;
}

export interface CourseRow {
  courseId: string;
  label: string;
  track: string;
  lessonsRead: number;
  totalLessons: number;
  nextLessonId: string | null;
}

export interface ProgressSummary {
  name: string;
  image: string | null;
  joinedAt: Date | null;
  totalLessonsRead: number;
  totalLessonsAvailable: number;
  coursesCompleted: number;
  lastActiveAt: Date | null;
  currentStreak: number;
  longestStreak: number;
  totalActiveDays: number;
  activeDaysLast30: number;
  heatmap: { date: string; active: boolean }[];
  perCourse: CourseRow[];
  quizzes: {
    attempted: number;
    avgScore: number | null;
    topScores: QuizScore[];
    reviewTargets: QuizScore[];
  };
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Build the full progress summary for a user. Returns null if the user
 * does not exist (lets the public route return a clean 404).
 */
export async function buildProgressSummary(
  prisma: PrismaClient,
  userId: string
): Promise<ProgressSummary | null> {
  const [progressRows, quizRows, user] = await Promise.all([
    prisma.lessonProgress.findMany({
      where: { userId },
      select: { lessonId: true, status: true, readAt: true, updatedAt: true },
    }),
    prisma.quizAttempt.findMany({
      where: { userId },
      select: { lessonId: true, score: true, total: true, updatedAt: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true, name: true, image: true },
    }),
  ]);

  if (!user) return null;

  // Build a Set of READ-or-MASTERED lesson IDs (the "solved" pool).
  const readLessons = new Set<string>();
  let lastActiveAt: Date | null = null;
  for (const r of progressRows) {
    if (r.status === "READ" || r.status === "MASTERED") {
      readLessons.add(r.lessonId);
    }
    const ts = r.readAt ?? r.updatedAt;
    if (!lastActiveAt || ts > lastActiveAt) lastActiveAt = ts;
  }

  // Per-course rollup using the static manifest.
  const perCourse: CourseRow[] = COURSES.map((c) => {
    let lessonsRead = 0;
    let nextLessonId: string | null = null;
    for (const lid of c.lessons) {
      if (readLessons.has(lid)) {
        lessonsRead += 1;
      } else if (nextLessonId === null) {
        nextLessonId = lid;
      }
    }
    return {
      courseId: c.id,
      label: c.label,
      track: c.track,
      lessonsRead,
      totalLessons: c.lessons.length,
      nextLessonId,
    };
  });

  const coursesCompleted = perCourse.filter(
    (c) => c.totalLessons > 0 && c.lessonsRead === c.totalLessons
  ).length;

  // All distinct UTC-day strings with any activity (lesson or quiz),
  // across the user's full history — used for streaks and total active days.
  const allActiveDays = new Set<string>();
  for (const r of progressRows) allActiveDays.add(dayKey(r.readAt ?? r.updatedAt));
  for (const q of quizRows) allActiveDays.add(dayKey(q.updatedAt));

  const totalActiveDays = allActiveDays.size;

  // Longest streak: longest run of consecutive calendar days in the
  // full activity set.
  let longestStreak = 0;
  if (allActiveDays.size > 0) {
    const sorted = [...allActiveDays].sort();
    let run = 1;
    longestStreak = 1;
    for (let i = 1; i < sorted.length; i++) {
      const prev = new Date(sorted[i - 1] + "T00:00:00Z");
      const cur = new Date(sorted[i] + "T00:00:00Z");
      const diffDays = Math.round(
        (cur.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000)
      );
      run = diffDays === 1 ? run + 1 : 1;
      if (run > longestStreak) longestStreak = run;
    }
  }

  // 30-day activity heatmap window.
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 29);
  thirtyDaysAgo.setUTCHours(0, 0, 0, 0);

  const activeDays30 = new Set<string>();
  for (const r of progressRows) {
    const ts = r.readAt ?? r.updatedAt;
    if (ts >= thirtyDaysAgo) activeDays30.add(dayKey(ts));
  }
  for (const q of quizRows) {
    if (q.updatedAt >= thirtyDaysAgo) activeDays30.add(dayKey(q.updatedAt));
  }

  const heatmap: { date: string; active: boolean }[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(thirtyDaysAgo);
    d.setUTCDate(d.getUTCDate() + i);
    const key = dayKey(d);
    heatmap.push({ date: key, active: activeDays30.has(key) });
  }

  // Current streak: consecutive active days ending today (or yesterday if
  // the user hasn't logged in today yet — same forgiveness window as before).
  const todayKey = dayKey(today);
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayKey = dayKey(yesterday);

  let currentStreak = 0;
  if (allActiveDays.has(todayKey) || allActiveDays.has(yesterdayKey)) {
    const cursor = new Date(today);
    if (!allActiveDays.has(todayKey)) cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (allActiveDays.has(dayKey(cursor))) {
      currentStreak += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
  }

  // Quiz aggregates.
  let totalQuizScore = 0;
  let totalQuizMax = 0;
  const quizPercents: QuizScore[] = [];
  for (const q of quizRows) {
    if (q.total > 0) {
      totalQuizScore += q.score;
      totalQuizMax += q.total;
      quizPercents.push({
        lessonId: q.lessonId,
        pct: Math.round((q.score / q.total) * 100),
      });
    }
  }
  const avgScore =
    totalQuizMax > 0 ? Math.round((totalQuizScore / totalQuizMax) * 100) : null;

  const topScores = [...quizPercents].sort((a, b) => b.pct - a.pct).slice(0, 3);
  const reviewTargets = quizPercents
    .filter((q) => q.pct < 70)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 5);

  return {
    name: user.name,
    image: user.image ?? null,
    joinedAt: user.createdAt ?? null,
    totalLessonsRead: readLessons.size,
    totalLessonsAvailable: TOTAL_LESSONS,
    coursesCompleted,
    lastActiveAt,
    currentStreak,
    longestStreak,
    totalActiveDays,
    activeDaysLast30: activeDays30.size,
    heatmap,
    perCourse,
    quizzes: {
      attempted: quizPercents.length,
      avgScore,
      topScores,
      reviewTargets,
    },
  };
}
