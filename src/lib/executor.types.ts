// Executor (/execute shim) wire contract + judge domain types.
//
// The executor is COMPUTE ONLY: it runs ONE program and reports how it exited.
// The BACKEND is the source of truth — it builds the program (user code + the
// hidden harness), parses per-test results from stdout, and computes the
// authoritative verdict. Hidden tests never leave the backend except to the
// executor. See PHASE1_SCHEMA_PREP.md / COMPILER_JUDGE_DESIGN.md.

import type {
  CheckerType,
  CodeVerdict,
  IoMode,
  TestKind,
  TestVisibility,
} from "@prisma/client";

/** Request to the executor /execute endpoint (engine-agnostic). */
export interface ExecuteRequest {
  language: string;
  version?: string;
  code: string;
  stdin?: string;
  args?: string[];
  limits?: Record<string, number>;
}

/** Normalized executor /execute response (from the shim). */
export interface ExecuteResponse {
  verdict: string; // executor-level PREVIEW verdict (exit-code based)
  runtimeMs: number | null;
  cpuMs?: number | null;
  memoryMb: number | null;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  compileStderr: string | null;
  raw?: unknown;
}

/** The slice of a ProblemTest row the judge needs to run/grade a single test. */
export interface TestSpec {
  id: string;
  name?: string | null;
  visibility: TestVisibility;
  kind: TestKind;
  ioMode: IoMode;
  checkerType: CheckerType;
  language?: string | null;
  input?: unknown;
  expectedOutput?: unknown;
  rtol?: number | null;
  atol?: number | null;
  harness?: string | null;
  weight: number;
}

/** A single test/assertion outcome the judge computes (pre-persistence). */
export interface PerTestResult {
  testId: string | null;
  name: string;
  visibility: TestVisibility;
  status: "PASS" | "FAIL" | "ERROR";
  checkerType: CheckerType;
  toleranceApplied: { rtol: number; atol: number } | null;
  numericDiff: { maxAbs: number; maxRel: number } | null;
  message: string | null;
  runtimeMs: number | null;
}

/** Raw per-assertion record emitted by the in-sandbox harness collector. */
export interface RawHarnessResult {
  name: string;
  status: "PASS" | "FAIL" | "ERROR";
  message: string | null;
  ms: number;
}

/** One executor invocation's outcome: the executor response + parsed results. */
export interface ExecOutcome {
  response: ExecuteResponse;
  results: PerTestResult[];
  /** Did the program emit the results sentinel? false => the program crashed
   *  before/without producing per-test output (syntax/import error, etc.). */
  sentinelFound: boolean;
}

/** Aggregate result over all per-test results + executor-level signals. */
export interface AggregateResult {
  verdict: CodeVerdict;
  passedCount: number;
  totalCount: number;
  score: number; // 0..1 (passed / total)
  runtimeMs: number | null;
  memoryMb: number | null;
}
