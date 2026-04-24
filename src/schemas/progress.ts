import { z } from "zod";

export const markProgressSchema = z.object({
  lessonId: z.string().min(1),
});

export const getCourseProgressSchema = z.object({
  courseId: z.string().min(1),
});
