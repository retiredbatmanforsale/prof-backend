// Program builder + result parser for the judge.
//
// The executor runs ONE program and returns stdout. To get per-test results we
// build a combined program: a collector shim (defines `__test__` + accumulates
// results) + the user's code + the test material, ending with a line that prints
// the results as JSON behind a sentinel. We then parse that JSON back out. This
// mirrors exactly what the frontend Pyodide worker does client-side, so the same
// `@__test__` harnesses (used by all current practice problems) run unchanged.
//
// Phase 2 implements the PYTHON path (HARNESS + CASE/FUNCTION_CALL), which is the
// entire current product. Other languages / STDIN_STDOUT cases throw a clear
// "not yet supported" error and are a tracked follow-up.

import type { RawHarnessResult, TestSpec } from "./executor.types.js";

export const RESULTS_SENTINEL = "___PROF_TEST_RESULTS___";
export const DEFAULT_RTOL = 1e-5;
export const DEFAULT_ATOL = 1e-8;

const PYTHON_LANGS = new Set(["python", "py", "python3"]);

function isPython(language: string): boolean {
  return PYTHON_LANGS.has(language.toLowerCase());
}

// Thread caps BEFORE numpy import (OpenBLAS), a non-interactive matplotlib
// backend + writable config dir, and the @__test__ collector + JSON emitter.
function pythonPreamble(): string {
  return [
    "import os as _os",
    "_os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')",
    "_os.environ.setdefault('OMP_NUM_THREADS', '1')",
    "_os.environ.setdefault('MPLBACKEND', 'Agg')",
    "_os.environ.setdefault('MPLCONFIGDIR', '/tmp/mpl')",
    "import json as _json, time as _time",
    "_PROF_RESULTS = []",
    "def __test__(name):",
    "    def _decorator(fn):",
    "        _t0 = _time.perf_counter()",
    "        try:",
    "            fn()",
    "            _st, _msg = 'PASS', None",
    "        except AssertionError as _e:",
    "            _st, _msg = 'FAIL', (str(_e) or 'assertion failed')",
    "        except Exception as _e:",
    "            _st, _msg = 'ERROR', f'{type(_e).__name__}: {_e}'",
    "        _PROF_RESULTS.append({'name': name, 'status': _st, 'message': _msg, 'ms': (_time.perf_counter() - _t0) * 1000})",
    "        return fn",
    "    return _decorator",
    "",
  ].join("\n");
}

function pythonEmit(): string {
  return `\nprint(${JSON.stringify(RESULTS_SENTINEL)} + _json.dumps(_PROF_RESULTS))`;
}

/**
 * Build a runnable program for one HARNESS test row: the collector shim + the
 * user's code + the harness text (a set of `@__test__` blocks) + the emitter.
 * Each `@__test__` in the harness becomes one entry in the parsed results.
 */
export function buildHarnessProgram(
  language: string,
  userCode: string,
  harness: string
): string {
  if (!isPython(language)) {
    throw new Error(
      `HARNESS execution for language "${language}" is not yet supported (python only in Phase 2)`
    );
  }
  return (
    pythonPreamble() +
    "\n# ── user code ──\n" +
    userCode +
    "\n# ── harness ──\n" +
    harness +
    pythonEmit()
  );
}

/**
 * Split a composed harness (problem preamble + `@__test__` blocks, as stored in a
 * ProblemTest row) back into its preamble and individual blocks. Mirrors the split
 * done at seed time. A row with no `@__test__` marker yields zero blocks.
 */
function splitHarnessBlocks(harness: string): { preamble: string; blocks: string[] } {
  const first = harness.indexOf("@__test__(");
  if (first === -1) return { preamble: harness, blocks: [] };
  const preamble = harness.slice(0, first);
  const blocks = harness.slice(first).split(/\n(?=@__test__\()/);
  return { preamble, blocks };
}

/**
 * Build ONE program for several HARNESS rows of the SAME problem (e.g. the SAMPLE
 * row + the HIDDEN row). All rows of a problem share the same preamble
 * (imports/helpers), so it is emitted once: numpy is imported a single time and
 * every test runs in one process, ≈halving wall time versus one `execute` per row.
 *
 * Returns the program plus the `@__test__` block count for each input harness, in
 * order, so the caller can attribute the flat results list back to each row's
 * visibility/checkerType BY POSITION — robust even when sample/hidden share a name.
 */
export function buildCombinedHarnessProgram(
  language: string,
  userCode: string,
  harnesses: string[]
): { program: string; counts: number[] } {
  if (!isPython(language)) {
    throw new Error(
      `HARNESS execution for language "${language}" is not yet supported (python only in Phase 2)`
    );
  }
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
  const harnessText =
    (preamble.trim() ? preamble.trimEnd() + "\n\n" : "") + allBlocks.join("\n\n");
  return {
    program:
      pythonPreamble() +
      "\n# ── user code ──\n" +
      userCode +
      "\n# ── harness ──\n" +
      harnessText +
      pythonEmit(),
    counts,
  };
}

/**
 * Build a runnable program for a batch of discrete CASE tests (FUNCTION_CALL):
 * each case is turned into a `@__test__` whose name is the case id (so results
 * map straight back to the ProblemTest row). `input` must be
 * `{ entrypoint: string, args: unknown[] }`; comparison is EXACT (==) or
 * ALL_CLOSE (numpy.allclose with rtol/atol). Forward-looking: no current
 * problem ships discrete cases, so this is exercised once such content exists.
 */
export function buildCaseProgram(
  language: string,
  userCode: string,
  cases: TestSpec[]
): string {
  if (!isPython(language)) {
    throw new Error(
      `CASE execution for language "${language}" is not yet supported (python only in Phase 2)`
    );
  }
  const blocks: string[] = [];
  for (const c of cases) {
    if (c.ioMode !== "FUNCTION_CALL") {
      throw new Error(
        `CASE ioMode "${c.ioMode}" is not yet supported (FUNCTION_CALL only in Phase 2)`
      );
    }
    const input = (c.input ?? {}) as { entrypoint?: string; args?: unknown[] };
    if (!input.entrypoint) {
      throw new Error(`CASE ${c.id} missing input.entrypoint`);
    }
    const argsJson = JSON.stringify(input.args ?? []);
    const expectedJson = JSON.stringify(c.expectedOutput ?? null);
    const rtol = c.rtol ?? DEFAULT_RTOL;
    const atol = c.atol ?? DEFAULT_ATOL;
    const cmp =
      c.checkerType === "ALL_CLOSE"
        ? `import numpy as _np; assert _np.allclose(_out, _exp, rtol=${rtol}, atol=${atol}), f"not close: {_out} vs {_exp}"`
        : `assert _out == _exp, f"got {_out!r}, want {_exp!r}"`;
    blocks.push(
      [
        `@__test__(${JSON.stringify(c.id)})`,
        `def _case_${c.id.replace(/[^A-Za-z0-9_]/g, "_")}():`,
        `    _args = _json.loads(${JSON.stringify(argsJson)})`,
        `    _exp = _json.loads(${JSON.stringify(expectedJson)})`,
        `    _out = globals()[${JSON.stringify(input.entrypoint)}](*_args)`,
        `    ${cmp}`,
        "",
      ].join("\n")
    );
  }
  return (
    pythonPreamble() +
    "\n# ── user code ──\n" +
    userCode +
    "\n# ── generated cases ──\n" +
    blocks.join("\n") +
    pythonEmit()
  );
}

/**
 * Parse the per-test results JSON the program printed behind the sentinel.
 * Returns null if the sentinel is absent (program crashed before emitting).
 */
export function parseResults(stdout: string): RawHarnessResult[] | null {
  const idx = stdout.lastIndexOf(RESULTS_SENTINEL);
  if (idx === -1) return null;
  const json = stdout.slice(idx + RESULTS_SENTINEL.length).trim();
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed as RawHarnessResult[];
  } catch {
    return null;
  }
}
