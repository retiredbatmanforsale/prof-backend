import type { FastifyInstance } from "fastify";
import { authenticate, optionalAuthenticate } from "../../hooks/auth.js";
import { lessonSlugParamSchema, syncLikesSchema } from "../../schemas/likes.js";

export default async function lessonLikesRoute(app: FastifyInstance) {
  // POST /lessons/:slug/likes — toggle the current user's like for a lesson.
  // Returns the new state so the client can reconcile its optimistic UI.
  app.post(
    "/:slug/likes",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = lessonSlugParamSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid lesson slug",
        });
      }
      const { slug } = parsed.data;
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

  // GET /lessons/:slug/likes — count + whether the caller has liked.
  // Public, but if a valid JWT is present we tell the caller whether
  // they've personally liked the lesson (used to fill the heart icon).
  app.get(
    "/:slug/likes",
    { preHandler: [optionalAuthenticate] },
    async (request, reply) => {
      const parsed = lessonSlugParamSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid lesson slug" });
      }
      const { slug } = parsed.data;
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

  // POST /lessons/likes/sync — drain anonymous localStorage likes into
  // the backend after a sign-in. Idempotent: existing rows are left
  // alone and the slug is reported as already-synced.
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

      // Dedupe in case the client sent duplicates.
      const uniqueSlugs = Array.from(new Set(slugs));

      const synced: string[] = [];
      for (const slug of uniqueSlugs) {
        try {
          await app.prisma.lessonLike.create({
            data: { userId, lessonSlug: slug },
          });
          synced.push(slug);
        } catch {
          // Either the unique constraint tripped (already liked — that's
          // fine, report it as "synced" so the client clears localStorage)
          // or some transient error. Either way we don't fail the whole
          // batch; surface as synced for already-liked, swallow otherwise.
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
}
