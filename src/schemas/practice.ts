import { z } from "zod";

// Phase 3: thin practice tracking. problemSlug is the practice-catalog slug
// (also the id used in lessonPracticeMap), so solved labs join back to lessons.
export const practiceAttemptSchema = z.object({
  problemSlug: z.string().min(1),
});

export const practiceSolveSchema = z.object({
  problemSlug: z.string().min(1),
});
