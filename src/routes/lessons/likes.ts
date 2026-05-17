import type { FastifyInstance } from "fastify";
import { authenticate, optionalAuthenticate } from "../../hooks/auth.js";
import { lessonSlugRegex, syncLikesSchema } from "../../schemas/likes.js";

// Lesson slugs are multi-segment paths (e.g.
// "ai-for-engineering/deep-sequence-modelling-rnn/foundations-of-deep-sequence-modeling")
// so the slug must come at the *end* of the route as a Fastify wildcard.
// Otherwise `:slug` matches one URL segment only and every multi-segment
// slug 404s. The literal `/sync` route below is registered first so
// Fastify's static-over-wildcard priority routes correctly.

function readSlug(request: { params: unknown }): string | null {
  const params = request.params as { "*"?: string } | undefined;
  const slug = params?.["*"] ?? "";
  return lessonSlugRegex.test(slug) ? slug : null;
}

export default async function lessonLikesRoute(app: FastifyInstance) {
  // POST /lessons/likes/sync — drain anonymous localStorage likes into
  // the backend after a sign-in. Idempotent. Registered *before* the
  // wildcard so it isn't shadowed.
  app.post(
    "/likes/sync",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = syncLikesSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const { slugs } = parsed.data;
      const userId = request.currentUser!.userId;

      const uniqueSlugs = Array.from(new Set(slugs));

      const synced: string[] = [];
      for (const slug of uniqueSlugs) {
        try {
          await app.prisma.lessonLike.create({
            data: { userId, lessonSlug: slug },
          });
          synced.push(slug);
        } catch {
          const existing = await app.prisma.lessonLike.findUnique({
            where: { userId_lessonSlug: { userId, lessonSlug: slug } },
            select: { id: true },
          });
          if (existing) synced.push(slug);
        }
      }

      return reply.send({ synced });
    },
  );

  // POST /lessons/likes/<slug...> — toggle the caller's like for a lesson.
  // Slug is a wildcard so multi-segment paths work.
  app.post(
    "/likes/*",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const slug = readSlug(request);
      if (!slug) {
        return reply.status(400).send({ error: "Invalid lesson slug" });
      }
      const userId = request.currentUser!.userId;

      const existing = await app.prisma.lessonLike.findUnique({
        where: { userId_lessonSlug: { userId, lessonSlug: slug } },
      });

      let liked: boolean;
      if (existing) {
        await app.prisma.lessonLike.delete({
          where: { userId_lessonSlug: { userId, lessonSlug: slug } },
        });
        liked = false;
      } else {
        await app.prisma.lessonLike.create({
          data: { userId, lessonSlug: slug },
        });
        liked = true;
      }

      const count = await app.prisma.lessonLike.count({
        where: { lessonSlug: slug },
      });

      return reply.send({ liked, count });
    },
  );

  // GET /lessons/likes/<slug...> — public count + auth-honored hasLiked.
  app.get(
    "/likes/*",
    { preHandler: [optionalAuthenticate] },
    async (request, reply) => {
      const slug = readSlug(request);
      if (!slug) {
        return reply.status(400).send({ error: "Invalid lesson slug" });
      }
      const userId = request.currentUser?.userId;

      const count = await app.prisma.lessonLike.count({
        where: { lessonSlug: slug },
      });

      let hasLiked = false;
      if (userId) {
        const row = await app.prisma.lessonLike.findUnique({
          where: { userId_lessonSlug: { userId, lessonSlug: slug } },
          select: { id: true },
        });
        hasLiked = !!row;
      }

      return reply.send({ count, hasLiked });
    },
  );
}
