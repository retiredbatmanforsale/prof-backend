import { z } from "zod";

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
});

export const tutorChatSchema = z.object({
  topic: z.string().min(1).max(100),
  concepts: z.array(z.string().min(1).max(100)).min(1).max(20),
  lessonId: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  history: z.array(messageSchema).max(30).default([]),
});
