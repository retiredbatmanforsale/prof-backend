// Assessment coding judge (Phase 2) — reuses the SAME shared judge() as practice.
//
//   runAssessmentCode    — SAMPLE tests only, no CodeSubmission (Run feedback).
//   submitAssessmentCode — ALL tests (sample + hidden), authoritative; creates an
//                          immutable CodeSubmission linked to the attempt/question
//                          (context=ASSESSMENT) + SubmissionTestResult rows.
//
// CATALOG questions only: the question's `catalogSlug` is the practice problem slug,
// so the SAME `problem_tests` rows back both practice and assessments (no duplicate
// storage). Hidden tests are redacted by the SAME serializer. Attempt-status and
// timer enforcement (attemptLifecycle) happen in the route before these run.
// Auto-grade / integrity wiring are intentionally NOT here (later phases).

import { Prisma, type PrismaClient } from "@prisma/client";
import { aggregateVerdict } from "./executor.mapper.js";
import { assertCodeSize, judge, NoTestsError } from "./judge.js";
import {
  serializeRunResult,
  serializeSubmissionResult,
  type RunResultView,
  type SubmissionResultView,
} from "./practice.serializer.js";

/** Run: SAMPLE tests only for a CATALOG question's problem. No submission stored. */
export async function runAssessmentCode(
  prisma: PrismaClient,
  args: { slug: string; language: string; code: string }
): Promise<RunResultView> {
  assertCodeSize(args.code);
  const sampleRows = await prisma.problemTest.findMany({
    where: { problemSlug: args.slug, visibility: "SAMPLE" },
    orderBy: { order: "asc" },
  });
  if (sampleRows.length === 0) {
    return serializeRunResult(null, [], "No sample tests configured yet.");
  }
  const outcomes = await judge(args.language, args.code, sampleRows);
  const agg = aggregateVerdict(outcomes);
  return serializeRunResult(agg, outcomes.flatMap((o) => o.results));
}

/**
 * Submit: SAMPLE + HIDDEN, authoritative. Creates an immutable CodeSubmission
 * (context=ASSESSMENT) tied to the attempt + question, with the anti-cheat device
 * snapshot, plus per-test rows. Does NOT mutate the AssessmentAttempt (the attempt
 * is finalized separately) and does NOT auto-grade (later phase).
 */
export async function submitAssessmentCode(
  prisma: PrismaClient,
  ctx: {
    userId: string;
    attemptId: string;
    assessmentId: string;
    questionId: string;
    organizationId?: string | null;
    sectionId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    clientFingerprint?: string | null;
  },
  args: { slug: string; language: string; code: string }
): Promise<SubmissionResultView> {
  assertCodeSize(args.code);

  const rows = await prisma.problemTest.findMany({
    where: { problemSlug: args.slug },
    orderBy: [{ visibility: "asc" }, { order: "asc" }],
  });
  if (rows.length === 0) throw new NoTestsError(args.slug);

  const outcomes = await judge(args.language, args.code, rows);
  const agg = aggregateVerdict(outcomes);
  const perTest = outcomes.flatMap((o) => o.results);

  const submission = await prisma.$transaction(async (tx) => {
    const created = await tx.codeSubmission.create({
      data: {
        userId: ctx.userId,
        problemSlug: args.slug,
        context: "ASSESSMENT",
        assessmentId: ctx.assessmentId,
        assessmentQuestionId: ctx.questionId,
        attemptId: ctx.attemptId,
        organizationId: ctx.organizationId ?? null,
        sectionId: ctx.sectionId ?? null,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
        clientFingerprint: ctx.clientFingerprint ?? null,
        language: args.language,
        code: args.code,
        verdict: agg.verdict,
        passedCount: agg.passedCount,
        totalCount: agg.totalCount,
        score: agg.score,
        runtimeMs: agg.runtimeMs ?? undefined,
        memoryKb: agg.memoryKb ?? undefined,
      },
    });

    if (perTest.length > 0) {
      await tx.submissionTestResult.createMany({
        data: perTest.map((r) => ({
          submissionId: created.id,
          testId: r.testId ?? undefined,
          name: r.name,
          visibility: r.visibility,
          status: r.status,
          checkerType: r.checkerType,
          toleranceApplied: r.toleranceApplied ?? Prisma.DbNull,
          numericDiff: r.numericDiff ?? Prisma.DbNull,
          message: r.message ?? undefined,
          runtimeMs: r.runtimeMs ?? undefined,
        })),
      });
    }

    return created;
  });

  return serializeSubmissionResult(submission, perTest);
}
