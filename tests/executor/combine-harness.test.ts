// Combined HARNESS execution: all rows of a problem run in ONE process (numpy
// imported once) and results are attributed back to each row by block position.

import { describe, it, expect } from "vitest";
import {
  buildCombinedHarnessProgram,
  RESULTS_SENTINEL,
} from "../../src/lib/executor.harness.js";

const userCode = "def add(a, b):\n    return a + b\n";
const sampleH =
  'import numpy as np\n\n@__test__("Reference example one")\ndef t():\n    assert add(1, 2) == 3\n\n' +
  '@__test__("Reference example two")\ndef t():\n    assert add(2, 2) == 4\n';
const hiddenH =
  'import numpy as np\n\n@__test__("Hidden a")\ndef t():\n    assert add(0, 0) == 0\n\n' +
  '@__test__("Hidden b")\ndef t():\n    assert add(5, 5) == 10\n\n' +
  '@__test__("Hidden c")\ndef t():\n    assert add(-1, 1) == 0\n';

describe("buildCombinedHarnessProgram", () => {
  it("emits ONE program with a single preamble and correct per-row block counts", () => {
    const { program, counts } = buildCombinedHarnessProgram("python", userCode, [
      sampleH,
      hiddenH,
    ]);
    // Sample row contributes 2 blocks, hidden row 3 — used for position attribution.
    expect(counts).toEqual([2, 3]);
    // numpy + user code appear exactly once → a single import in a single process.
    expect(program.split("import numpy as np").length - 1).toBe(1);
    expect(program.split("def add(a, b):").length - 1).toBe(1);
    // Every test block from both rows is present, in order, ending with the sentinel.
    for (const name of [
      "Reference example one",
      "Reference example two",
      "Hidden a",
      "Hidden b",
      "Hidden c",
    ]) {
      expect(program).toContain(name);
    }
    expect(program).toContain(RESULTS_SENTINEL);
  });

  it("reports zero blocks for an empty/harness-less row", () => {
    const { counts } = buildCombinedHarnessProgram("python", userCode, ["", sampleH]);
    expect(counts).toEqual([0, 2]);
  });

  it("rejects non-python languages with a clear error", () => {
    expect(() =>
      buildCombinedHarnessProgram("javascript", userCode, [sampleH])
    ).toThrow(/not yet supported/);
  });

  it("sums block counts to the total number of @__test__ across rows", () => {
    const { counts } = buildCombinedHarnessProgram("python", userCode, [
      sampleH,
      hiddenH,
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
  });
});
