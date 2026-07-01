import { AttemptStatus, Prisma, type PrismaClient } from "@prisma/client";
import { autoGrade, gradeAttempt, writeAutoGradeEntries } from "./grading.js";

/**
 * Timed-assessment enforcement, server-side.
 *
 * An attempt has a hard deadline = the EARLIER of (startedAt + durationMinutes)
 * and the assessment's dueAt. Past that, an open attempt (IN_PROGRESS / EXITED)
 * must be finalized. We enforce this two ways (both needed):
 *   - Lazy: every attempt access point (get / start / save / exit / result)
 *     finalizes an expired attempt before proceeding, so a student can never
 *     keep working past time.
 *   - Sweep: a scheduled job finalizes expired attempts the student abandoned
 *     and never returned to, so nothing is stuck IN_PROGRESS forever.
 * Both call autoFinalizeAttempt(), so the result is identical either way.
 */

const OPEN_STATUSES: AttemptStatus[] = [AttemptStatus.IN_PROGRESS, AttemptStatus.EXITED];

type TimedAssessment = { durationMinutes: number | null; dueAt: Date | null };

/** The instant a timed attempt must close, or null when it has no time limit. */
export function attemptDeadline(a: TimedAssessment, startedAt: Date): Date | null {
  const ends: number[] = [];
  if (a.durationMinutes && a.durationMinutes > 0) {
    ends.push(startedAt.getTime() + a.durationMinutes * 60_000);
  }
  if (a.dueAt) ends.push(a.dueAt.getTime());
  if (ends.length === 0) return null;
  return new Date(Math.min(...ends));
}

/** True when an open attempt is past its deadline and must be finalized. */
export function isAttemptExpired(
  a: TimedAssessment,
  attempt: { status: AttemptStatus; startedAt: Date },
  now: Date = new Date()
): boolean {
  if (!OPEN_STATUSES.includes(attempt.status)) return false;
  const deadline = attemptDeadline(a, attempt.startedAt);
  return deadline != null && now.getTime() > deadline.getTime();
}

/**
 * Auto-submit + auto-grade an expired attempt from its LAST SAVED answers.
 * Same finalize path as a manual submit: objective questions scored, subjective
 * flagged pendingReview, and a fully-objective attempt's score flows straight
 * into any AUTO gradebook component. Caller checks isAttemptExpired() first.
 */
export async function autoFinalizeAttempt(
  prisma: PrismaClient,
  assessment: { id: string; questions: Parameters<typeof autoGrade>[0] },
  attempt: { id: string; userId: string; answers: unknown; reviewMarks?: unknown }
) {
  const saved = (attempt.answers ?? {}) as { answers?: Record<string, unknown> };
  const prevReview = (attempt.reviewMarks ?? {}) as Record<string, number>;
  // Phase 4: coding questions are auto-graded from their best CodeSubmission.
  const graded = await gradeAttempt(prisma, assessment.questions, attempt.id, saved.answers ?? {}, prevReview);
  const fullyGraded = graded.pendingQuestionIds.length === 0;
  const now = new Date();
  const mergedReview = { ...prevReview, ...graded.codingMarks };

  const updated = await prisma.assessmentAttempt.update({
    where: { id: attempt.id },
    data: {
      status: AttemptStatus.SUBMITTED,
      submittedAt: now,
      score: graded.score,
      maxScore: graded.maxScore,
      reviewMarks: mergedReview as Prisma.InputJsonValue,
      pendingReview: !fullyGraded,
      gradedAt: fullyGraded ? now : null,
    },
  });
  if (fullyGraded) {
    await writeAutoGradeEntries(prisma, assessment.id, attempt.userId, graded.score, graded.maxScore);
  }
  return updated;
}
