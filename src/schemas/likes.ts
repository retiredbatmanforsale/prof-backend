import { z } from "zod";

// Slug validation — keep it permissive enough for our content paths
// (e.g. "ai-for-engineering/agentic-ai/bare-llm-loop") but reject
// anything that looks like injection or absurd-length spam.
const slugRegex = /^[a-z0-9/-]{1,200}$/;

export const lessonSlugParamSchema = z.object({
  slug: z.string().regex(slugRegex, "Invalid lesson slug"),
});

export const syncLikesSchema = z.object({
  slugs: z.array(z.string().regex(slugRegex)).max(500),
});
