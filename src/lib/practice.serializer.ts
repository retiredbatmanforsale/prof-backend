// Response serializers for the practice judge. SINGLE PURPOSE: make it
// structurally impossible for HIDDEN test material to reach the client. Hidden
// tests contribute to counts only — never their name, message, input, or
// expected output. Sample tests (already client-visible) are returned in full.

import type { AggregateResult, PerTestResult } from "./executor.types.js";

/**
 * Test-authoring mode for the problem. The client uses it to decide how to present
 * runtime/memory: CASE (deterministic / DSA) shows them prominently LeetCode-style;
 * HARNESS (statistical/invariant ML) de-emphasizes them — they're dominated by the
 * numpy import and not the learning signal.
 */
export type ProblemMode = "HARNESS" | "CASE" | "MIXED";

interface SampleTestView {
  name: string;
  status: "PASS" | "FAIL" | "ERROR";
  message: string | null;
  runtimeMs: number | null;
}

function sampleView(r: PerTestResult): SampleTestView {
  return {
    name: r.name,
    status: r.status,
    message: r.message,
    runtimeMs: r.runtimeMs,
  };
}

export interface RunResultView {
  verdict: string | null;
  mode: ProblemMode;
  passedCount: number;
  totalCount: number;
  score: number;
  runtimeMs: number | null;
  memoryKb: number | null;
  tests: SampleTestView[]; // Run executes SAMPLE tests only — all safe to show
  note?: string;
}

export function serializeRunResult(
  agg: AggregateResult | null,
  perTest: PerTestResult[],
  mode: ProblemMode = "HARNESS",
  note?: string
): RunResultView {
  return {
    verdict: agg?.verdict ?? null,
    mode,
    passedCount: agg?.passedCount ?? 0,
    totalCount: agg?.totalCount ?? 0,
    score: agg?.score ?? 0,
    runtimeMs: agg?.runtimeMs ?? null,
    memoryKb: agg?.memoryKb ?? null,
    tests: perTest.map(sampleView),
    ...(note ? { note } : {}),
  };
}

export interface SubmissionResultView {
  id: string;
  verdict: string;
  mode: ProblemMode;
  passedCount: number;
  totalCount: number;
  score: number;
  runtimeMs: number | null;
  memoryKb: number | null;
  language: string;
  createdAt: Date;
  sampleTests: SampleTestView[];
  hidden: { passed: number; total: number }; // counts ONLY — redacted
}

export function serializeSubmissionResult(
  submission: {
    id: string;
    verdict: string;
    passedCount: number;
    totalCount: number;
    score: number | null;
    runtimeMs: number | null;
    memoryKb: number | null;
    language: string;
    createdAt: Date;
  },
  perTest: PerTestResult[],
  mode: ProblemMode = "HARNESS"
): SubmissionResultView {
  const sample = perTest.filter((r) => r.visibility === "SAMPLE");
  const hidden = perTest.filter((r) => r.visibility === "HIDDEN");
  return {
    id: submission.id,
    verdict: submission.verdict,
    mode,
    passedCount: submission.passedCount,
    totalCount: submission.totalCount,
    score: submission.score ?? 0,
    runtimeMs: submission.runtimeMs,
    memoryKb: submission.memoryKb,
    language: submission.language,
    createdAt: submission.createdAt,
    sampleTests: sample.map(sampleView),
    hidden: {
      passed: hidden.filter((r) => r.status === "PASS").length,
      total: hidden.length,
    },
  };
}
