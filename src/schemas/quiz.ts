import { z } from "zod";

export const submitQuizSchema = z.object({
  lessonId: z.string().min(1),
  score: z.number().int().min(0),
  total: z.number().int().min(1),
  answers: z.array(
    z.object({
      questionId: z.string(),
      selectedIndex: z.number().int(),
      correctIndex: z.number().int(),
      isCorrect: z.boolean(),
    })
  ),
});
