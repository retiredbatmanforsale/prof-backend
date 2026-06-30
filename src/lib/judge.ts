// Shared code-execution judge — used by BOTH practice and assessments.
//
// The executor is compute-only: it runs ONE program and returns stdout. The
// BACKEND builds the program, parses per-test results, and computes the verdict.
// Hidden tests never leave the backend except to the executor; per-test results
// carry their row's `visibility` so the serializer can redact HIDDEN material.
//
// Combined-harness optimization (parity with prof-backend PR #34): ALL HARNESS
// rows of a problem (e.g. SAMPLE + HIDDEN) run in ONE process so numpy is imported
// once (≈halving wall time vs one execute per row). We do this WITHOUT changing
// executor.harness.ts: combine the rows' harness text into a single harness
// (shared preamble once + every @__test__ block) and build one program. Results
// are attributed back to each row BY BLOCK POSITION (robust to duplicate names).

import { type ProblemTest } from "@prisma/client";
import { execute } from "./executor.client.js";
import {
  buildCaseProgram,
  buildHarnessProgram,
  DEFAULT_ATOL,
  DEFAULT_RTOL,
  parseResults,
} from "./executor.harness.js";
import { buildPerTestResults } from "./executor.mapper.js";
import type { ExecOutcome, PerTestResult, TestSpec } from "./executor.types.js";

export const MAX_CODE_BYTES = 256 * 1024;

/** Thrown when a problem has no configured tests — routes map it to 422. */
export class NoTestsError extends Error {
  constructor(public readonly problemSlug: string) {
    super(`No tests configured for problem "${problemSlug}"`);
    this.name = "NoTestsError";
  }
}

export function assertCodeSize(code: string): void {
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

/** Split a composed harness (preamble + @__test__ blocks) into its parts. */
export function splitHarnessBlocks(harness: string): {
  preamble: string;
  blocks: string[];
} {
  const first = harness.indexOf("@__test__(");
  if (first === -1) return { preamble: harness, blocks: [] };
  return {
    preamble: harness.slice(0, first),
    blocks: harness.slice(first).split(/\n(?=@__test__\()/),
  };
}

/**
 * Combine several HARNESS rows of one problem into a single harness string
 * (shared preamble once + every block) and report the @__test__ block count per
 * input row, in order, for position attribution. Exported for unit testing.
 */
export function combineHarnesses(harnesses: string[]): {
  combined: string;
  counts: number[];
} {
  let preamble = "";
  const allBlocks: string[] = [];
  const counts: number[] = [];
  for (const h of harnesses) {
    const { preamble: p, blocks } = splitHarnessBlocks(h ?? "");
    // Rows of one problem share an identical preamble; keep the first non-empty one.
    if (!preamble.trim() && p.trim()) preamble = p;
    for (const b of blocks) allBlocks.push(b.trimEnd());
    counts.push(blocks.length);
  }
  const combined =
    (preamble.trim() ? preamble.trimEnd() + "\n\n" : "") + allBlocks.join("\n\n");
  return { combined, counts };
}

/**
 * Run the user's code against the given test rows on the executor. HARNESS rows
 * run in ONE combined process; CASE rows run as one batched call. Per-test results
 * carry each row's visibility/checkerType so verdict + redaction stay correct.
 */
export async function judge(
  language: string,
  userCode: string,
  rows: ProblemTest[]
): Promise<ExecOutcome[]> {
  const outcomes: ExecOutcome[] = [];
  const harnessRows = rows.filter((r) => r.kind === "HARNESS" && r.harness);
  const caseRows = rows.filter((r) => r.kind === "CASE");

  if (harnessRows.length > 0) {
    const { combined, counts } = combineHarnesses(
      harnessRows.map((r) => r.harness as string)
    );
    const program = buildHarnessProgram(language, userCode, combined);
    const response = await execute({ language, code: program });
    const raw = parseResults(response.stdout);
    if (raw === null) {
      outcomes.push({ response, results: [], sentinelFound: false });
    } else {
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
      // Defensive: any unattributed tail folds into the last row.
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
