import { z } from "zod";

// Phase 3: thin practice tracking. problemSlug is the practice-catalog slug
// (also the id used in lessonPracticeMap), so solved labs join back to lessons.
export const practiceAttemptSchema = z.object({
  problemSlug: z.string().min(1),
});

export const practiceSolveSchema = z.object({
  problemSlug: z.string().min(1),
});

// ─── Phase 2: code-execution judge ───
// 256 KB cap mirrors the CodeSubmission/PracticeDraft service cap.
const MAX_CODE = 256 * 1024;

export const slugParamSchema = z.object({
  slug: z.string().min(1),
});

// Run / Submit share a body: chosen language + source. Run is non-authoritative
// (sample tests only); Submit is authoritative (sample + hidden).
export const runCodeSchema = z.object({
  language: z.string().min(1),
  code: z.string().min(1).max(MAX_CODE),
});

export const submitCodeSchema = runCodeSchema;

// Draft autosave: code may be empty (a cleared editor still saves).
export const saveDraftSchema = z.object({
  language: z.string().min(1),
  code: z.string().max(MAX_CODE),
});
