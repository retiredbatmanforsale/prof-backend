// Practice judge service (Phase 2 backend wiring).
//
//   runPracticeCode    — SAMPLE tests only, saves the draft, NO CodeSubmission.
//   submitPracticeCode — ALL tests (sample + hidden), authoritative; creates an
//                        immutable CodeSubmission + SubmissionTestResult rows and
//                        updates the PracticeAttempt summary.
//   savePracticeDraft / getPracticeDraft — the mutable latest-code draft.
//
// Judging (build program → executor → parse → verdict, with hidden-test redaction
// and the combined-harness optimization) lives in the SHARED judge — src/lib/judge.ts
// — reused verbatim by the assessment service.

import { Prisma, type PrismaClient } from "@prisma/client";
import { aggregateVerdict } from "./executor.mapper.js";
import { assertCodeSize, judge, NoTestsError } from "./judge.js";
import {
  serializeRunResult,
  serializeSubmissionResult,
  type RunResultView,
  type SubmissionResultView,
} from "./practice.serializer.js";

// Re-exported for the route layer (practice/code.ts); single source is judge.ts.
export { NoTestsError, MAX_CODE_BYTES } from "./judge.js";

export async function savePracticeDraft(
  prisma: PrismaClient,
  userId: string,
  args: { problemSlug: string; language: string; code: string }
) {
  assertCodeSize(args.code);
  return prisma.practiceDraft.upsert({
    where: { userId_problemSlug: { userId, problemSlug: args.problemSlug } },
    create: {
      userId,
      problemSlug: args.problemSlug,
      language: args.language,
      code: args.code,
    },
    update: { language: args.language, code: args.code },
    select: { problemSlug: true, language: true, code: true, updatedAt: true },
  });
}

export async function getPracticeDraft(
  prisma: PrismaClient,
  userId: string,
  problemSlug: string
) {
  return prisma.practiceDraft.findUnique({
    where: { userId_problemSlug: { userId, problemSlug } },
    select: { problemSlug: true, language: true, code: true, updatedAt: true },
  });
}

/** Run: SAMPLE tests only, save the draft, never create a CodeSubmission. */
export async function runPracticeCode(
  prisma: PrismaClient,
  userId: string,
  args: { problemSlug: string; language: string; code: string }
): Promise<RunResultView> {
  assertCodeSize(args.code);
  const { problemSlug, language, code } = args;

  // Preserve the latest draft + count the run as an attempt (parity with the
  // legacy /practice/attempt behaviour).
  await savePracticeDraft(prisma, userId, args);
  await prisma.practiceAttempt.upsert({
    where: { userId_problemSlug: { userId, problemSlug } },
    create: { userId, problemSlug, attempts: 1 },
    update: { attempts: { increment: 1 } },
  });

  const sampleRows = await prisma.problemTest.findMany({
    where: { problemSlug, visibility: "SAMPLE" },
    orderBy: { order: "asc" },
  });
  if (sampleRows.length === 0) {
    return serializeRunResult(null, [], "No sample tests configured yet.");
  }

  const outcomes = await judge(language, code, sampleRows);
  const agg = aggregateVerdict(outcomes);
  const perTest = outcomes.flatMap((o) => o.results);
  return serializeRunResult(agg, perTest);
}

/** Submit: ALL tests, authoritative, immutable submission + per-test rows. */
export async function submitPracticeCode(
  prisma: PrismaClient,
  ctx: { userId: string; organizationId?: string | null; sectionId?: string | null },
  args: { problemSlug: string; language: string; code: string }
): Promise<SubmissionResultView> {
  assertCodeSize(args.code);
  const { userId, organizationId = null, sectionId = null } = ctx;
  const { problemSlug, language, code } = args;

  // Latest code is preserved on submit too.
  await savePracticeDraft(prisma, userId, args);

  const rows = await prisma.problemTest.findMany({
    where: { problemSlug },
    orderBy: [{ visibility: "asc" }, { order: "asc" }],
  });
  if (rows.length === 0) throw new NoTestsError(problemSlug);

  const outcomes = await judge(language, code, rows);
  const agg = aggregateVerdict(outcomes);
  const perTest = outcomes.flatMap((o) => o.results);
  const accepted = agg.verdict === "ACCEPTED";
  const now = new Date();

  const submission = await prisma.$transaction(async (tx) => {
    const created = await tx.codeSubmission.create({
      data: {
        userId,
        problemSlug,
        context: "PRACTICE",
        organizationId,
        sectionId,
        language,
        code,
        verdict: agg.verdict,
        passedCount: agg.passedCount,
        totalCount: agg.totalCount,
        score: agg.score,
        runtimeMs: agg.runtimeMs ?? undefined,
        // agg.memoryMb is MB; DB column `memoryKb` (Int) stores rounded MB (see memory-unit fix).
        memoryKb: agg.memoryMb != null ? Math.round(agg.memoryMb) : undefined,
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

    // Summary update — solved/solvedAt are sticky; bestScore is a max.
    const existing = await tx.practiceAttempt.findUnique({
      where: { userId_problemSlug: { userId, problemSlug } },
      select: { solved: true, solvedAt: true, bestScore: true, solvedLanguage: true },
    });
    const solved = (existing?.solved ?? false) || accepted;
    const solvedAt = existing?.solvedAt ?? (accepted ? now : null);
    const bestScore = Math.max(existing?.bestScore ?? 0, agg.score);
    const solvedLanguage = existing?.solvedLanguage ?? (accepted ? language : null);

    await tx.practiceAttempt.upsert({
      where: { userId_problemSlug: { userId, problemSlug } },
      create: {
        userId,
        problemSlug,
        attempts: 1,
        solved,
        solvedAt,
        bestScore,
        solvedLanguage,
        lastSubmissionId: created.id,
      },
      update: {
        attempts: { increment: 1 },
        solved,
        solvedAt,
        bestScore,
        solvedLanguage,
        lastSubmissionId: created.id,
      },
    });

    return created;
  });

  return serializeSubmissionResult(submission, perTest);
}
