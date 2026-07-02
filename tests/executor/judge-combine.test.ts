// Shared judge: HARNESS rows of a problem combine into ONE program (numpy once),
// with per-row @__test__ block counts for position attribution.

import { describe, it, expect } from "vitest";
import { combineHarnesses, splitHarnessBlocks } from "../../src/lib/judge.js";

const sampleH =
  'import numpy as np\n\n@__test__("Reference example one")\ndef t():\n    assert add(1, 2) == 3\n\n' +
  '@__test__("Reference example two")\ndef t():\n    assert add(2, 2) == 4\n';
const hiddenH =
  'import numpy as np\n\n@__test__("Hidden a")\ndef t():\n    assert add(0, 0) == 0\n\n' +
  '@__test__("Hidden b")\ndef t():\n    assert add(5, 5) == 10\n\n' +
  '@__test__("Hidden c")\ndef t():\n    assert add(-1, 1) == 0\n';

describe("combineHarnesses", () => {
  it("emits a single shared preamble and correct per-row block counts", () => {
    const { combined, counts } = combineHarnesses([sampleH, hiddenH]);
    expect(counts).toEqual([2, 3]); // 2 sample + 3 hidden
    expect(combined.split("import numpy as np").length - 1).toBe(1); // preamble once
    for (const name of [
      "Reference example one",
      "Reference example two",
      "Hidden a",
      "Hidden b",
      "Hidden c",
    ]) {
      expect(combined).toContain(name);
    }
  });

  it("block counts sum to the total number of @__test__ across rows", () => {
    const { counts } = combineHarnesses([sampleH, hiddenH]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("treats an empty/harness-less row as zero blocks", () => {
    const { counts } = combineHarnesses(["", sampleH]);
    expect(counts).toEqual([0, 2]);
  });

  it("splitHarnessBlocks separates preamble from blocks", () => {
    const { preamble, blocks } = splitHarnessBlocks(sampleH);
    expect(preamble.trim()).toBe("import numpy as np");
    expect(blocks).toHaveLength(2);
  });
});
