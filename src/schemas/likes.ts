import { z } from "zod";

// Slug validation — permissive enough for our multi-segment content paths
// (e.g. "ai-for-engineering/agentic-ai/bare-llm-loop") but rejects anything
// that looks like injection or absurd-length spam.
export const lessonSlugRegex = /^[a-z0-9/-]{1,200}$/;

export const syncLikesSchema = z.object({
  slugs: z.array(z.string().regex(lessonSlugRegex)).max(500),
});
