import type { FastifyInstance } from "fastify";
import { authenticate } from "../../hooks/auth.js";
import { COURSES, TOTAL_LESSONS } from "../../lib/courseManifest.js";

/**
 * GET /progress/summary — single payload powering the user dashboard on
 * /account. LeetCode-style: one big number to push up + per-course bars +
 * 30-day activity heatmap.
 */
export default async function progressSummaryRoute(app: FastifyInstance) {
  app.get(
    "/summary",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = request.currentUser!.userId;

      // One round-trip each: lesson progress, quiz attempts, user joinedAt.
      const [progressRows, quizRows, user] = await Promise.all([
        app.prisma.lessonProgress.findMany({
          where: { userId },
          select: { lessonId: true, status: true, readAt: true, updatedAt: true },
        }),
        app.prisma.quizAttempt.findMany({
          where: { userId },
          select: { lessonId: true, score: true, total: true, updatedAt: true },
        }),
        app.prisma.user.findUnique({
          where: { id: userId },
          select: { createdAt: true },
        }),
      ]);

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
      const perCourse = COURSES.map((c) => {
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

      // 30-day activity heatmap: distinct UTC-day strings of any lesson activity.
      // Quiz submissions also count as activity.
      const today = new Date();
      const thirtyDaysAgo = new Date(today);
      thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 29);
      thirtyDaysAgo.setUTCHours(0, 0, 0, 0);

      const dayKey = (d: Date) => d.toISOString().slice(0, 10);
      const activeDays = new Set<string>();

      for (const r of progressRows) {
        const ts = r.readAt ?? r.updatedAt;
        if (ts >= thirtyDaysAgo) activeDays.add(dayKey(ts));
      }
      for (const q of quizRows) {
        if (q.updatedAt >= thirtyDaysAgo) activeDays.add(dayKey(q.updatedAt));
      }

      // Pre-build the full 30-day bitmap so the UI can render a heatmap
      // without doing date math on the client.
      const heatmap: { date: string; active: boolean }[] = [];
      for (let i = 0; i < 30; i++) {
        const d = new Date(thirtyDaysAgo);
        d.setUTCDate(d.getUTCDate() + i);
        const key = dayKey(d);
        heatmap.push({ date: key, active: activeDays.has(key) });
      }

      // Streak: consecutive active days ending today (or yesterday if user
      // hasn't logged in today yet — same forgiveness window LeetCode uses).
      const todayKey = dayKey(today);
      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yesterdayKey = dayKey(yesterday);

      let currentStreak = 0;
      const cursor = new Date(today);
      if (!activeDays.has(todayKey) && !activeDays.has(yesterdayKey)) {
        currentStreak = 0;
      } else {
        if (!activeDays.has(todayKey)) cursor.setUTCDate(cursor.getUTCDate() - 1);
        // Walk backwards through full activity history (not just 30d window).
        const allActiveDays = new Set<string>();
        for (const r of progressRows) {
          allActiveDays.add(dayKey(r.readAt ?? r.updatedAt));
        }
        for (const q of quizRows) {
          allActiveDays.add(dayKey(q.updatedAt));
        }
        while (allActiveDays.has(dayKey(cursor))) {
          currentStreak += 1;
          cursor.setUTCDate(cursor.getUTCDate() - 1);
        }
      }

      // Quiz aggregates.
      let totalQuizScore = 0;
      let totalQuizMax = 0;
      const quizPercents: { lessonId: string; pct: number }[] = [];
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
        totalQuizMax > 0
          ? Math.round((totalQuizScore / totalQuizMax) * 100)
          : null;

      const topScores = [...quizPercents]
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 3);
      const reviewTargets = quizPercents
        .filter((q) => q.pct < 70)
        .sort((a, b) => a.pct - b.pct)
        .slice(0, 5);

      return reply.send({
        joinedAt: user?.createdAt ?? null,
        totalLessonsRead: readLessons.size,
        totalLessonsAvailable: TOTAL_LESSONS,
        lastActiveAt,
        currentStreak,
        activeDaysLast30: activeDays.size,
        heatmap,
        perCourse,
        quizzes: {
          attempted: quizPercents.length,
          avgScore,
          topScores,
          reviewTargets,
        },
      });
    }
  );
}
