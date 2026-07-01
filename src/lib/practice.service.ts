// Practice judge service (Phase 2 backend wiring).
//
//   runPracticeCode    — SAMPLE tests only, saves the draft, NO CodeSubmission.
//   submitPracticeCode — ALL tests (sample + hidden), authoritative; creates an
//                        immutable CodeSubmission + SubmissionTestResult rows and
//                        updates the PracticeAttempt summary.
//   savePracticeDraft / getPracticeDraft — the mutable latest-code draft.
//
// Source-of-truth rules: the executor is compute-only; the backend builds the
// program, parses per-test output, computes the verdict, and persists. Hidden
// tests are fetched here and sent ONLY to the executor — never to the client
// (see practice.serializer.ts).

import { Prisma, type PrismaClient, type ProblemTest } from "@prisma/client";
import { execute } from "./executor.client.js";
import {
  buildCaseProgram,
  buildCombinedHarnessProgram,
  DEFAULT_ATOL,
  DEFAULT_RTOL,
  parseResults,
} from "./executor.harness.js";
import { aggregateVerdict, buildPerTestResults } from "./executor.mapper.js";
import {
  serializeRunResult,
  serializeSubmissionResult,
  type RunResultView,
  type SubmissionResultView,
} from "./practice.serializer.js";
import type {
  ExecOutcome,
  PerTestResult,
  TestSpec,
} from "./executor.types.js";

export const MAX_CODE_BYTES = 256 * 1024;

/** Thrown when a problem has no configured tests — the route maps it to 422. */
export class NoTestsError extends Error {
  constructor(public readonly problemSlug: string) {
    super(`No tests configured for problem "${problemSlug}"`);
    this.name = "NoTestsError";
  }
}

function assertCodeSize(code: string): void {
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    const err = new Error("code exceeds 256 KB limit");
    err.name = "CodeTooLargeError";
    throw err;
  }
}

function toleranceFor(row: ProblemTest): { rtol: number; atol: number } | null {
  if (row.checkerType !== "ALL_CLOSE") return null;
  return { rtol: row.rtol ?? DEFAULT_RTOL, atol: row.atol ?? DEFAULT_ATOL };
}

function toSpec(row: ProblemTest): TestSpec {
  return {
    id: row.id,
    name: row.id,
    visibility: row.visibility,
    kind: row.kind,
    ioMode: row.ioMode,
    checkerType: row.checkerType,
    language: row.language,
    input: row.input,
    expectedOutput: row.expectedOutput,
    rtol: row.rtol,
    atol: row.atol,
    harness: row.harness,
    weight: row.weight,
  };
}

/** "HARNESS" | "CASE" | "MIXED" — drives mode-aware perf display on the client. */
export type ProblemMode = "HARNESS" | "CASE" | "MIXED";

export function deriveMode(rows: Pick<ProblemTest, "kind">[]): ProblemMode {
  const hasHarness = rows.some((r) => r.kind === "HARNESS");
  const hasCase = rows.some((r) => r.kind === "CASE");
  if (hasHarness && hasCase) return "MIXED";
  return hasCase ? "CASE" : "HARNESS";
}

/**
 * Run the user's code against the given test rows on the executor. ALL HARNESS
 * rows of the problem (e.g. SAMPLE + HIDDEN) are combined into ONE program/process
 * so numpy is imported once — roughly halving wall time versus one execute per row
 * — and CASE rows run as one batched call. Results are attributed back to each
 * row's visibility/checkerType (HARNESS: by block position; CASE: by id) so the
 * verdict + hidden-test redaction stay correct.
 */
async function judge(
  language: string,
  userCode: string,
  rows: ProblemTest[]
): Promise<ExecOutcome[]> {
  const outcomes: ExecOutcome[] = [];
  const harnessRows = rows.filter((r) => r.kind === "HARNESS" && r.harness);
  const caseRows = rows.filter((r) => r.kind === "CASE");

  if (harnessRows.length > 0) {
    const { program, counts } = buildCombinedHarnessProgram(
      language,
      userCode,
      harnessRows.map((r) => r.harness as string)
    );
    const response = await execute({ language, code: program });
    const raw = parseResults(response.stdout);
    if (raw === null) {
      outcomes.push({ response, results: [], sentinelFound: false });
    } else {
      // Attribute the flat result list back to each row by block position.
      const results: PerTestResult[] = [];
      let cursor = 0;
      harnessRows.forEach((row, idx) => {
        const slice = raw.slice(cursor, cursor + counts[idx]);
        cursor += counts[idx];
        results.push(
          ...buildPerTestResults(slice, {
            testId: row.id,
            visibility: row.visibility,
            checkerType: row.checkerType,
            tolerance: toleranceFor(row),
          })
        );
      });
      // Defensive: any unattributed tail folds into the last row so it still
      // counts toward the verdict rather than silently vanishing.
      if (cursor < raw.length) {
        const last = harnessRows[harnessRows.length - 1];
        results.push(
          ...buildPerTestResults(raw.slice(cursor), {
            testId: last.id,
            visibility: last.visibility,
            checkerType: last.checkerType,
            tolerance: toleranceFor(last),
          })
        );
      }
      outcomes.push({ response, results, sentinelFound: true });
    }
  }

  if (caseRows.length > 0) {
    const program = buildCaseProgram(language, userCode, caseRows.map(toSpec));
    const response = await execute({ language, code: program });
    const raw = parseResults(response.stdout);
    if (raw === null) {
      outcomes.push({ response, results: [], sentinelFound: false });
    } else {
      const byId = new Map(caseRows.map((r) => [r.id, r]));
      const results: PerTestResult[] = raw.flatMap((r) => {
        const row = byId.get(r.name);
        if (!row) return [];
        return buildPerTestResults([r], {
          testId: row.id,
          visibility: row.visibility,
          checkerType: row.checkerType,
          tolerance: toleranceFor(row),
        });
      });
      outcomes.push({ response, results, sentinelFound: true });
    }
  }

  return outcomes;
}

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
    return serializeRunResult(null, [], "HARNESS", "No sample tests configured yet.");
  }

  const outcomes = await judge(language, code, sampleRows);
  const agg = aggregateVerdict(outcomes);
  const perTest = outcomes.flatMap((o) => o.results);
  return serializeRunResult(agg, perTest, deriveMode(sampleRows));
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

  return serializeSubmissionResult(submission, perTest, deriveMode(rows));
}
