import { z } from "zod";

// The four canonical activity sources, mirrored from the frontend's
// `streakMemory.ts` ActivitySource type. New sources require updating
// both ends in lockstep.
export const activitySourceSchema = z.enum([
  "lesson",
  "quiz",
  "practice",
  "tutor",
]);

export const recordEventSchema = z.object({
  source: activitySourceSchema,
  // Free-text contextual label for the activity feed (e.g. lesson
  // title). Capped to avoid spam / oversized JSON column writes.
  label: z.string().max(200).default(""),
});

export type RecordEventInput = z.infer<typeof recordEventSchema>;
