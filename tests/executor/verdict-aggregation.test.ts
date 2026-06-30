import { describe, expect, it } from "vitest";
import { CodeVerdict } from "@prisma/client";
import {
  aggregateVerdict,
  buildPerTestResults,
  mapExecutorVerdict,
} from "../../src/lib/executor.mapper.js";
import type {
  ExecOutcome,
  ExecuteResponse,
  PerTestResult,
} from "../../src/lib/executor.types.js";

function resp(over: Partial<ExecuteResponse> = {}): ExecuteResponse {
  return {
    verdict: "ACCEPTED",
    runtimeMs: 10,
    memoryKb: 1000,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    compileStderr: null,
    ...over,
  };
}

function pt(
  status: PerTestResult["status"],
  visibility: PerTestResult["visibility"] = "HIDDEN"
): PerTestResult {
  return {
    testId: "t1",
    name: "n",
    visibility,
    status,
    checkerType: "CUSTOM",
    toleranceApplied: null,
    numericDiff: null,
    message: status === "PASS" ? null : "boom",
    runtimeMs: 1,
  };
}

function outcome(results: PerTestResult[], over: Partial<ExecuteResponse> = {}): ExecOutcome {
  return { response: resp(over), results, sentinelFound: true };
}

describe("mapExecutorVerdict", () => {
  it("maps known strings and falls back to ERROR", () => {
    expect(mapExecutorVerdict("ACCEPTED")).toBe(CodeVerdict.ACCEPTED);
    expect(mapExecutorVerdict("TIME_LIMIT_EXCEEDED")).toBe(CodeVerdict.TIME_LIMIT_EXCEEDED);
    expect(mapExecutorVerdict("nonsense")).toBe(CodeVerdict.ERROR);
    expect(mapExecutorVerdict(undefined)).toBe(CodeVerdict.ERROR);
  });
});

describe("aggregateVerdict", () => {
  it("ACCEPTED when every assertion passes; score 1", () => {
    const r = aggregateVerdict([outcome([pt("PASS"), pt("PASS")])]);
    expect(r.verdict).toBe(CodeVerdict.ACCEPTED);
    expect(r.passedCount).toBe(2);
    expect(r.totalCount).toBe(2);
    expect(r.score).toBe(1);
  });

  it("WRONG_ANSWER when some assertions fail; score is the pass fraction", () => {
    const r = aggregateVerdict([outcome([pt("PASS"), pt("FAIL"), pt("FAIL")])]);
    expect(r.verdict).toBe(CodeVerdict.WRONG_ANSWER);
    expect(r.passedCount).toBe(1);
    expect(r.totalCount).toBe(3);
    expect(r.score).toBeCloseTo(1 / 3);
  });

  it("RUNTIME_ERROR when an assertion raises (status ERROR)", () => {
    const r = aggregateVerdict([outcome([pt("PASS"), pt("ERROR")])]);
    expect(r.verdict).toBe(CodeVerdict.RUNTIME_ERROR);
  });

  it("RUNTIME_ERROR when the program never emitted results (crash)", () => {
    const o: ExecOutcome = {
      response: resp({ verdict: "RUNTIME_ERROR", stdout: "" }),
      results: [],
      sentinelFound: false,
    };
    expect(aggregateVerdict([o]).verdict).toBe(CodeVerdict.RUNTIME_ERROR);
  });

  it("COMPILATION_ERROR takes precedence over everything", () => {
    const ce: ExecOutcome = {
      response: resp({ verdict: "COMPILATION_ERROR" }),
      results: [],
      sentinelFound: false,
    };
    const r = aggregateVerdict([outcome([pt("FAIL")]), ce]);
    expect(r.verdict).toBe(CodeVerdict.COMPILATION_ERROR);
  });

  it("TLE / MLE surface from executor-level signals", () => {
    expect(
      aggregateVerdict([
        { response: resp({ verdict: "TIME_LIMIT_EXCEEDED" }), results: [], sentinelFound: false },
      ]).verdict
    ).toBe(CodeVerdict.TIME_LIMIT_EXCEEDED);
    expect(
      aggregateVerdict([
        { response: resp({ verdict: "MEMORY_LIMIT_EXCEEDED" }), results: [], sentinelFound: false },
      ]).verdict
    ).toBe(CodeVerdict.MEMORY_LIMIT_EXCEEDED);
  });

  it("ERROR when there is nothing to grade", () => {
    expect(aggregateVerdict([outcome([])]).verdict).toBe(CodeVerdict.ERROR);
  });

  it("aggregates counts/runtime/memory across multiple executor calls", () => {
    const r = aggregateVerdict([
      outcome([pt("PASS", "SAMPLE")], { runtimeMs: 5, memoryKb: 100 }),
      outcome([pt("PASS"), pt("PASS")], { runtimeMs: 7, memoryKb: 400 }),
    ]);
    expect(r.verdict).toBe(CodeVerdict.ACCEPTED);
    expect(r.totalCount).toBe(3);
    expect(r.runtimeMs).toBe(12); // summed
    expect(r.memoryKb).toBe(400); // max
  });
});

describe("buildPerTestResults", () => {
  it("attributes raw assertions to a row's visibility/checker/tolerance", () => {
    const out = buildPerTestResults(
      [{ name: "case A", status: "PASS", message: null, ms: 3.7 }],
      { testId: "row1", visibility: "HIDDEN", checkerType: "ALL_CLOSE", tolerance: { rtol: 1e-5, atol: 1e-8 } }
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      testId: "row1",
      name: "case A",
      visibility: "HIDDEN",
      status: "PASS",
      checkerType: "ALL_CLOSE",
      toleranceApplied: { rtol: 1e-5, atol: 1e-8 },
      runtimeMs: 4,
    });
  });
});
