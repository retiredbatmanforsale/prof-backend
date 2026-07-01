// Verdict mapping + aggregation. The BACKEND is the source of truth: it turns
// raw per-assertion output + executor-level signals into the authoritative
// verdict, counts, and score. `aggregateVerdict` is a pure function (unit-tested
// in tests/executor/verdict-aggregation.test.ts).

import { CodeVerdict } from "@prisma/client";
import type {
  AggregateResult,
  ExecOutcome,
  PerTestResult,
  RawHarnessResult,
} from "./executor.types.js";
import type { CheckerType, TestVisibility } from "@prisma/client";

/** Normalize an executor-level verdict string to the CodeVerdict enum. */
export function mapExecutorVerdict(s: string | null | undefined): CodeVerdict {
  switch (s) {
    case "ACCEPTED":
      return CodeVerdict.ACCEPTED;
    case "WRONG_ANSWER":
      return CodeVerdict.WRONG_ANSWER;
    case "TIME_LIMIT_EXCEEDED":
      return CodeVerdict.TIME_LIMIT_EXCEEDED;
    case "MEMORY_LIMIT_EXCEEDED":
      return CodeVerdict.MEMORY_LIMIT_EXCEEDED;
    case "RUNTIME_ERROR":
      return CodeVerdict.RUNTIME_ERROR;
    case "COMPILATION_ERROR":
      return CodeVerdict.COMPILATION_ERROR;
    default:
      return CodeVerdict.ERROR;
  }
}

/** Attribute raw harness assertions to a ProblemTest row's metadata. */
export function buildPerTestResults(
  raw: RawHarnessResult[],
  ctx: {
    testId: string | null;
    visibility: TestVisibility;
    checkerType: CheckerType;
    tolerance: { rtol: number; atol: number } | null;
  }
): PerTestResult[] {
  return raw.map((r) => ({
    testId: ctx.testId,
    name: r.name,
    visibility: ctx.visibility,
    status: r.status,
    checkerType: ctx.checkerType,
    toleranceApplied: ctx.tolerance,
    numericDiff: null,
    message: r.message,
    runtimeMs: Number.isFinite(r.ms) ? Math.round(r.ms) : null,
  }));
}

function sumOrNull(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((n): n is number => typeof n === "number");
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

function maxOrNull(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((n): n is number => typeof n === "number");
  return nums.length ? Math.max(...nums) : null;
}

/**
 * Compute the authoritative result over every executor invocation for a
 * submission. Executor-level failures take precedence (they mean the program
 * never produced gradable output); otherwise the verdict comes from the
 * per-assertion results.
 *
 * Precedence: COMPILATION_ERROR > TIME_LIMIT_EXCEEDED > MEMORY_LIMIT_EXCEEDED >
 * (program crashed, no results) RUNTIME_ERROR > (any assertion errored)
 * RUNTIME_ERROR > (any assertion failed) WRONG_ANSWER > ACCEPTED.
 */
export function aggregateVerdict(outcomes: ExecOutcome[]): AggregateResult {
  const all: PerTestResult[] = outcomes.flatMap((o) => o.results);
  const passedCount = all.filter((r) => r.status === "PASS").length;
  const totalCount = all.length;
  const score = totalCount ? passedCount / totalCount : 0;
  const runtimeMs = sumOrNull(outcomes.map((o) => o.response.runtimeMs));
  const memoryMb = maxOrNull(outcomes.map((o) => o.response.memoryMb));

  const execVerdicts = outcomes.map((o) => mapExecutorVerdict(o.response.verdict));
  const base = { passedCount, totalCount, score, runtimeMs, memoryMb };

  if (execVerdicts.includes(CodeVerdict.COMPILATION_ERROR)) {
    return { ...base, verdict: CodeVerdict.COMPILATION_ERROR };
  }
  if (execVerdicts.includes(CodeVerdict.TIME_LIMIT_EXCEEDED)) {
    return { ...base, verdict: CodeVerdict.TIME_LIMIT_EXCEEDED };
  }
  if (execVerdicts.includes(CodeVerdict.MEMORY_LIMIT_EXCEEDED)) {
    return { ...base, verdict: CodeVerdict.MEMORY_LIMIT_EXCEEDED };
  }
  // A program that didn't emit results crashed (syntax/import error, top-level
  // exception) — that's a runtime error, not a wrong answer.
  if (outcomes.some((o) => !o.sentinelFound)) {
    return { ...base, verdict: CodeVerdict.RUNTIME_ERROR };
  }
  if (totalCount === 0) {
    return { ...base, verdict: CodeVerdict.ERROR };
  }
  if (all.some((r) => r.status === "ERROR")) {
    return { ...base, verdict: CodeVerdict.RUNTIME_ERROR };
  }
  if (passedCount === totalCount) {
    return { ...base, verdict: CodeVerdict.ACCEPTED };
  }
  return { ...base, verdict: CodeVerdict.WRONG_ANSWER };
}
