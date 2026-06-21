import { z } from "zod";

export const markProgressSchema = z.object({
  lessonId: z.string().min(1),
});

export const getCourseProgressSchema = z.object({
  courseId: z.string().min(1),
});

// ─── Phase 3: robust lesson tracking ───

export const lessonStartSchema = z.object({
  lessonId: z.string().min(1),
});

// Heartbeat: the lesson page reports a small slice of elapsed time plus the
// deepest scroll % reached so far. addSeconds is clamped server-side so a
// tampered client can't inflate time-spent in one shot.
export const lessonHeartbeatSchema = z.object({
  lessonId: z.string().min(1),
  addSeconds: z.number().int().min(0).max(120),
  scrollPercent: z.number().int().min(0).max(100),
});

export const lessonCompleteSchema = z.object({
  lessonId: z.string().min(1),
});

// Engagement gate: a lesson can only be completed once the learner has spent a
// meaningful amount of time AND scrolled through a meaningful portion. Opening
// the page (or skimming) never satisfies this.
export const MIN_COMPLETE_SECONDS = 20;
export const MIN_COMPLETE_SCROLL = 70;
