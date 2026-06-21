import { z } from "zod";

// Phase 5 gradebook. Component types mirror the Prisma GradeComponentType enum.
export const gradeComponentTypeSchema = z.enum([
  "MIDSEM",
  "ENDSEM",
  "QUIZ",
  "VIVA",
  "PROJECT",
  "LAB",
]);

export const createGradeComponentSchema = z.object({
  name: z.string().min(1).max(120),
  type: gradeComponentTypeSchema,
  maxMarks: z.number().positive().max(10000).default(100),
  weight: z.number().min(0).max(100).default(0),
  // Optional AUTO link to an assessment (scores flow once grading exists).
  assessmentId: z.string().min(1).optional(),
});

export const updateGradeComponentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  type: gradeComponentTypeSchema.optional(),
  maxMarks: z.number().positive().max(10000).optional(),
  weight: z.number().min(0).max(100).optional(),
  assessmentId: z.string().min(1).nullable().optional(),
});

// A manual grade entry (faculty types the score).
export const upsertGradeEntrySchema = z.object({
  componentId: z.string().min(1),
  studentId: z.string().min(1),
  score: z.number().min(0).max(10000),
});
