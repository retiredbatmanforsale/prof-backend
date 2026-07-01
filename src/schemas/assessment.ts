import { z } from "zod";

/**
 * Validation for the faculty assessment authoring surface (/faculty/assessments).
 * The save flow is composite: one POST/PATCH body carries the assessment meta,
 * its ordered questions, and the cohort (section) ids to assign — persisted in
 * a single transaction (see src/routes/faculty/assessments.ts).
 */

// ─── Questions ────────────────────────────────────────────────
// A question is either a CATALOG reference (a practice-problem slug from the
// frontend catalog + a lightweight snapshot) or a CUSTOM question authored
// inline. Evaluation is out of scope, so answer keys are optional and only
// ever stored — never executed/graded — and are stripped from student payloads.

const customQuestionContentSchema = z.object({
  // The inline question type. Open-ended on purpose — the UI may add types
  // without a schema migration. Stored verbatim in AssessmentQuestion.content.
  type: z.enum(["MCQ", "MULTI_SELECT", "SHORT_ANSWER", "LONG_ANSWER", "CODING"]),
  prompt: z.string().min(1, "Question prompt is required"),
  // MCQ / MULTI_SELECT
  options: z.array(z.string().min(1)).max(10).optional(),
  correctIndex: z.number().int().min(0).optional(),
  correctIndexes: z.array(z.number().int().min(0)).optional(),
  // CODING (no execution in this slice — metadata only). The structured
  // fields below mirror the PROF practice-problem template so the builder can
  // author a full coding problem inline. Stored as-is in `content`.
  starter: z.string().optional(),
  language: z.string().optional(),
  languages: z.array(z.string()).optional(),
  difficulty: z.enum(["Easy", "Medium", "Hard"]).optional(),
  tags: z.array(z.string()).optional(),
  topic: z.string().optional(),
  background: z.string().optional(),
  statement: z.string().optional(),
  inputFormat: z.string().optional(),
  outputFormat: z.string().optional(),
  constraints: z.string().optional(),
  examples: z.string().optional(),
  explanation: z.string().optional(),
  hiddenTests: z.string().optional(),
});

const catalogSnapshotSchema = z
  .object({
    difficulty: z.enum(["Easy", "Medium", "Hard"]).optional(),
    topics: z.array(z.string()).optional(),
    companies: z.array(z.string()).optional(),
  })
  .optional();

export const questionInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("CATALOG"),
    catalogSlug: z.string().min(1, "catalogSlug is required for CATALOG questions"),
    title: z.string().max(300).optional(),
    points: z.number().int().min(0).max(1000).optional(),
    // Snapshot of the referenced problem so lists render without the catalog.
    content: catalogSnapshotSchema,
  }),
  z.object({
    kind: z.literal("CUSTOM"),
    title: z.string().max(300).optional(),
    points: z.number().int().min(0).max(1000).optional(),
    content: customQuestionContentSchema,
  }),
]);

// ─── Assessment ───────────────────────────────────────────────

// Shared metadata + in-test rule fields (all optional; backed by the additive
// columns on `assessments`). Used by both faculty and campus-admin authoring.
const metadataShape = {
  track: z.enum(["DSA", "AIML", "MIXED"]).optional(),
  attemptPolicy: z.enum(["UNLIMITED", "SINGLE", "NONE"]).optional(),
  lateEntryAllowed: z.boolean().optional(),
  shuffleQuestions: z.boolean().optional(),
  navigationMode: z.enum(["FREE", "SEQUENTIAL"]).optional(),
  autoSubmit: z.boolean().optional(),
};

// POST /faculty/assessments — create. Questions + cohort ids are optional at
// create time (faculty can save an empty draft and fill it in later).
export const createAssessmentSchema = z.object({
  title: z.string().min(1, "Title is required").max(300),
  description: z.string().max(5000).optional(),
  durationMinutes: z.number().int().min(0).max(100000).optional(),
  // Accept ISO date strings; coerced to Date in the handler.
  opensAt: z.string().datetime().optional(),
  dueAt: z.string().datetime().optional(),
  questions: z.array(questionInputSchema).max(200).optional(),
  sectionIds: z.array(z.string().min(1)).max(100).optional(),
  // Publish immediately instead of saving as a draft.
  publish: z.boolean().optional(),
  ...metadataShape,
});

// PATCH /faculty/assessments/:id — composite save. Any provided field is
// updated; `questions` / `sectionIds`, when present, REPLACE the existing set
// (the UI sends the full intended state). Omit a field to leave it untouched.
export const updateAssessmentSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(5000).nullable().optional(),
  durationMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  opensAt: z.string().datetime().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  status: z.enum(["DRAFT", "PUBLISHED"]).optional(),
  questions: z.array(questionInputSchema).max(200).optional(),
  sectionIds: z.array(z.string().min(1)).max(100).optional(),
  ...metadataShape,
});

// ─── Attempt persistence ──────────────────────────────────────
// The full in-progress response state, persisted in
// AssessmentAttempt.answers (JSONB). No grading — just the student's work.
export const attemptStateSchema = z.object({
  answers: z.record(z.any()).optional(),
  currentQuestion: z.number().int().min(0).optional(),
  flaggedQuestions: z.array(z.string()).optional(),
  draftCode: z.record(z.string()).optional(),
});

// ─── Assessment coding (Phase 2) ──────────────────────────────
// Run / Submit a CATALOG coding question inside an attempt. 256 KB code cap mirrors
// the CodeSubmission/judge cap. `fingerprint` is an optional anti-cheat device hash.
const MAX_CODE = 256 * 1024;

export const assessmentCodeParamsSchema = z.object({
  id: z.string().min(1),
  qid: z.string().min(1),
});

export const assessmentRunCodeSchema = z.object({
  language: z.string().min(1),
  code: z.string().min(1).max(MAX_CODE),
  fingerprint: z.string().max(512).optional(),
});

export const assessmentSubmitCodeSchema = assessmentRunCodeSchema;

// Integrity (proctoring) event reported by the client. Only client-sendable
// signal types are accepted; WARNING_ISSUED / AUTO_SUBMIT / RESUME are server-only.
export const assessmentIntegritySchema = z.object({
  type: z.enum([
    "TAB_SWITCH", "FOCUS_LOSS", "COPY_ATTEMPT", "PASTE_ATTEMPT",
    "CUT_ATTEMPT", "CONTEXT_MENU", "FULLSCREEN_EXIT", "FULLSCREEN_ENTER",
  ]),
  questionId: z.string().optional(),
  clientTs: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
});

export type AttemptStateInput = z.infer<typeof attemptStateSchema>;
export type QuestionInput = z.infer<typeof questionInputSchema>;
export type CreateAssessmentInput = z.infer<typeof createAssessmentSchema>;
export type UpdateAssessmentInput = z.infer<typeof updateAssessmentSchema>;
