import type { FastifyInstance } from "fastify";
import {
  runCodeSchema,
  saveDraftSchema,
  slugParamSchema,
  submitCodeSchema,
} from "../../schemas/practice.js";
import { authenticate } from "../../hooks/auth.js";
import {
  getPracticeDraft,
  NoTestsError,
  runPracticeCode,
  savePracticeDraft,
  submitPracticeCode,
} from "../../lib/practice.service.js";

/**
 * Phase 2 code-execution judge (/practice/:slug/*).
 *
 *   POST /practice/:slug/run    — sample tests only; saves draft; no submission.
 *   POST /practice/:slug/submit — authoritative: sample + hidden, immutable
 *                                 CodeSubmission + per-test rows + summary update.
 *   GET  /practice/:slug/draft  — the caller's latest draft for this problem.
 *   PUT  /practice/:slug/draft  — upsert the latest draft.
 *
 * Hidden tests never reach the client — responses are redacted by the serializer.
 */
export default async function practiceCodeRoute(app: FastifyInstance) {
  app.post(
    "/:slug/run",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const params = slugParamSchema.safeParse(request.params);
      const body = runCodeSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: {
            ...(params.success ? {} : params.error.flatten().fieldErrors),
            ...(body.success ? {} : body.error.flatten().fieldErrors),
          },
        });
      }
      const userId = request.currentUser!.userId;
      const result = await runPracticeCode(app.prisma, userId, {
        problemSlug: params.data.slug,
        language: body.data.language,
        code: body.data.code,
      });
      return reply.send({ success: true, result });
    }
  );

  app.post(
    "/:slug/submit",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const params = slugParamSchema.safeParse(request.params);
      const body = submitCodeSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: {
            ...(params.success ? {} : params.error.flatten().fieldErrors),
            ...(body.success ? {} : body.error.flatten().fieldErrors),
          },
        });
      }
      const user = request.currentUser!;
      try {
        const result = await submitPracticeCode(
          app.prisma,
          { userId: user.userId, organizationId: user.organizationId },
          {
            problemSlug: params.data.slug,
            language: body.data.language,
            code: body.data.code,
          }
        );
        return reply.send({ success: true, result });
      } catch (err) {
        if (err instanceof NoTestsError) {
          return reply.status(422).send({
            error: "NO_TESTS",
            message: "This problem has no tests configured yet.",
          });
        }
        throw err;
      }
    }
  );

  app.get(
    "/:slug/draft",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const params = slugParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: params.error.flatten().fieldErrors,
        });
      }
      const userId = request.currentUser!.userId;
      const draft = await getPracticeDraft(app.prisma, userId, params.data.slug);
      return reply.send({ draft });
    }
  );

  app.put(
    "/:slug/draft",
    { preHandler: [authenticate] },
    async (request, reply) => {
      const params = slugParamSchema.safeParse(request.params);
      const body = saveDraftSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: {
            ...(params.success ? {} : params.error.flatten().fieldErrors),
            ...(body.success ? {} : body.error.flatten().fieldErrors),
          },
        });
      }
      const userId = request.currentUser!.userId;
      const draft = await savePracticeDraft(app.prisma, userId, {
        problemSlug: params.data.slug,
        language: body.data.language,
        code: body.data.code,
      });
      return reply.send({ success: true, draft });
    }
  );
}
