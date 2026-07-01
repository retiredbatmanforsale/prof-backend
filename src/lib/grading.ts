import { GradeSource, type PrismaClient } from "@prisma/client";
import type { AssessmentQuestion } from "@prisma/client";

/**
 * Phase 6 — assessment grading engine.
 *
 * Auto-gradable now: MCQ (correctIndex) and MULTI_SELECT (correctIndexes).
 * Everything else (SHORT_ANSWER / LONG_ANSWER "subjective", CODING / "design")
 * is held for faculty review — submitting auto-scores the objective part and
 * flags the rest as pendingReview. Once every question has a mark (auto or
 * faculty-assigned), the attempt is finalized and its score flows into any
 * AUTO GradeComponent linked to the assessment.
 */

type AnswerMap = Record<string, unknown>;

const AUTO_TYPES = new Set(["MCQ", "MULTI_SELECT"]);

function questionType(q: AssessmentQuestion): string {
  if (q.kind === "CATALOG") return "CODING"; // catalog = coding problem
  const c = (q.content ?? {}) as Record<string, unknown>;
  // Normalize case + the multi-select spelling (builder writes UPPERCASE; seed/legacy
  // may write lowercase) so objective auto-grading matches regardless of source.
  if (typeof c.type !== "string") return "SHORT_ANSWER";
  const t = c.type.toUpperCase().replace(/-/g, "_");
  return t === "MULTISELECT" ? "MULTI_SELECT" : t;
}

function points(q: AssessmentQuestion): number {
  return typeof q.points === "number" ? q.points : 0;
}

function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

export interface PerQuestionResult {
  questionId: string;
  type: string;
  points: number;
  /** Marks earned (null = awaiting faculty review). */
  awarded: number | null;
  auto: boolean;
}

export interface AutoGradeResult {
  autoScore: number; // objective marks earned so far
  autoMax: number; // total objective marks available
  pendingMax: number; // total marks awaiting review
  maxScore: number; // autoMax + pendingMax = all points
  pendingQuestionIds: string[];
  perQuestion: PerQuestionResult[];
}

/** Grade the objective part of an attempt; flag the rest for review. */
export function autoGrade(
  questions: AssessmentQuestion[],
  answers: AnswerMap
): AutoGradeResult {
  let autoScore = 0;
  let autoMax = 0;
  let pendingMax = 0;
  const pendingQuestionIds: string[] = [];
  const perQuestion: PerQuestionResult[] = [];

  for (const q of questions) {
    const pts = points(q);
    const type = questionType(q);
    const content = (q.content ?? {}) as Record<string, unknown>;
    const ans = answers[q.id];

    if (AUTO_TYPES.has(type)) {
      autoMax += pts;
      let awarded = 0;
      if (type === "MCQ") {
        const correct = content.correctIndex;
        const picked = typeof ans === "number" ? ans : Number(ans);
        if (typeof correct === "number" && !Number.isNaN(picked) && picked === correct) {
          awarded = pts;
        }
      } else {
        // MULTI_SELECT — exact-set match, all-or-nothing.
        const correct = Array.isArray(content.correctIndexes)
          ? (content.correctIndexes as number[])
          : [];
        const picked = Array.isArray(ans) ? (ans as number[]).map(Number) : [];
        if (correct.length > 0 && sameSet(correct, picked)) awarded = pts;
      }
      autoScore += awarded;
      perQuestion.push({ questionId: q.id, type, points: pts, awarded, auto: true });
    } else {
      // Subjective / coding / design — manual review.
      pendingMax += pts;
      pendingQuestionIds.push(q.id);
      perQuestion.push({ questionId: q.id, type, points: pts, awarded: null, auto: false });
    }
  }

  return {
    autoScore,
    autoMax,
    pendingMax,
    maxScore: autoMax + pendingMax,
    pendingQuestionIds,
    perQuestion,
  };
}

/**
 * Final score = objective marks + faculty review marks (clamped to each
 * question's points). Returns the total and whether anything is still pending.
 */
export function applyReviewMarks(
  questions: AssessmentQuestion[],
  answers: AnswerMap,
  reviewMarks: Record<string, number>
): { score: number; maxScore: number; pendingQuestionIds: string[] } {
  const auto = autoGrade(questions, answers);
  let manual = 0;
  const stillPending: string[] = [];

  for (const qid of auto.pendingQuestionIds) {
    const q = questions.find((x) => x.id === qid)!;
    const raw = reviewMarks[qid];
    if (typeof raw === "number" && !Number.isNaN(raw)) {
      manual += Math.max(0, Math.min(points(q), raw));
    } else {
      stillPending.push(qid);
    }
  }

  return {
    score: auto.autoScore + manual,
    maxScore: auto.maxScore,
    pendingQuestionIds: stillPending,
  };
}

export interface GradedAttempt {
  score: number;
  maxScore: number;
  pendingQuestionIds: string[];
  perQuestion: PerQuestionResult[];
  /** Marks auto-derived from each CATALOG coding question's best submission. */
  codingMarks: Record<string, number>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Phase 4 — full attempt grade INCLUDING coding. Objective questions grade via
 * autoGrade; each CATALOG coding question is auto-graded from the BEST
 * CodeSubmission for (attemptId, questionId): awarded = clamp(bestScore,0,1) *
 * points (ACCEPTED→full, partial→proportional, no submission→0). Remaining
 * non-auto questions (subjective/written, custom coding) fall back to faculty
 * reviewMarks; whatever is still unmarked stays pending.
 */
export async function gradeAttempt(
  prisma: PrismaClient,
  questions: AssessmentQuestion[],
  attemptId: string,
  answers: AnswerMap,
  reviewMarks: Record<string, number>
): Promise<GradedAttempt> {
  const base = autoGrade(questions, answers);
  const qById = new Map(questions.map((q) => [q.id, q]));

  // Best coding submission per CATALOG question → awarded marks.
  const codingMarks: Record<string, number> = {};
  for (const q of questions) {
    if (q.kind !== "CATALOG") continue;
    const best = await prisma.codeSubmission.findFirst({
      where: { attemptId, assessmentQuestionId: q.id, context: "ASSESSMENT" },
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      select: { score: true },
    });
    const ratio = best && typeof best.score === "number" ? Math.max(0, Math.min(1, best.score)) : 0;
    codingMarks[q.id] = round2(ratio * points(q));
  }

  let score = 0;
  const pendingQuestionIds: string[] = [];
  const perQuestion: PerQuestionResult[] = base.perQuestion.map((pq) => {
    if (pq.auto) { score += pq.awarded ?? 0; return pq; }
    const q = qById.get(pq.questionId)!;
    if (q.kind === "CATALOG") {
      const awarded = codingMarks[pq.questionId] ?? 0;
      score += awarded;
      return { ...pq, auto: true, awarded }; // coding is now auto-graded
    }
    const raw = reviewMarks[pq.questionId];
    if (typeof raw === "number" && !Number.isNaN(raw)) {
      const awarded = Math.max(0, Math.min(pq.points, raw));
      score += awarded;
      return { ...pq, awarded };
    }
    pendingQuestionIds.push(pq.questionId);
    return pq;
  });

  return { score: round2(score), maxScore: base.maxScore, pendingQuestionIds, perQuestion, codingMarks };
}

/**
 * Push a finalized attempt score into the gradebook: every AUTO GradeComponent
 * linked to this assessment gets a GradeEntry (source=AUTO) for this student,
 * scaled to the component's maxMarks. Idempotent (upsert by component+student).
 */
export async function writeAutoGradeEntries(
  prisma: PrismaClient,
  assessmentId: string,
  studentId: string,
  score: number,
  maxScore: number
): Promise<number> {
  const components = await prisma.gradeComponent.findMany({
    where: { assessmentId },
    select: { id: true, maxMarks: true },
  });
  if (components.length === 0) return 0;

  const ratio = maxScore > 0 ? score / maxScore : 0;
  let written = 0;
  for (const c of components) {
    const scaled = Math.round(ratio * c.maxMarks * 100) / 100;
    const existing = await prisma.gradeEntry.findUnique({
      where: { componentId_studentId: { componentId: c.id, studentId } },
      select: { source: true },
    });
    // Never clobber a faculty MANUAL override; create or refresh AUTO entries.
    if (existing && existing.source === GradeSource.MANUAL) continue;
    await prisma.gradeEntry.upsert({
      where: { componentId_studentId: { componentId: c.id, studentId } },
      create: {
        componentId: c.id,
        studentId,
        score: scaled,
        source: GradeSource.AUTO,
        enteredByMemberId: null,
      },
      update: { score: scaled, source: GradeSource.AUTO },
    });
    written += 1;
  }
  return written;
}
