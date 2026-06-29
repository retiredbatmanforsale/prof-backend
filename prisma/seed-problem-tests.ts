// Content migration: import the frontend practice problems' `@__test__`
// harnesses into the backend ProblemTest table so the judge has server-side
// tests to run. Idempotent (re-runnable): clears + recreates rows per slug.
//
// Mapping (current data is 100% python harness-based):
//   harness-based problem  -> kind=HARNESS, checkerType=CUSTOM, language=python
//   @__test__ named "example"/"reference"/"sample" -> SAMPLE (client-visible Run)
//   the rest                                        -> HIDDEN (Submit only)
// Forward-looking: a problem shipping structured discrete cases would instead map
// to kind=CASE with checkerType ALL_CLOSE (numeric/tensor) or EXACT (DSA). No such
// data exists yet, so only the HARNESS path runs today.
//
// Source dir: PRACTICE_PROBLEMS_DIR (defaults to ../prof-frontend/data/practice/problems).
// Run: npm run db:seed-problem-tests

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SAMPLE_NAME = /\b(example|reference|sample)\b/i;
const TEST_MARKER = "@__test__(";

interface Block {
  name: string;
  text: string;
}

/** Split a python harness into its preamble (imports/helpers) + @__test__ blocks. */
function splitHarness(src: string): { preamble: string; blocks: Block[] } {
  const first = src.indexOf(TEST_MARKER);
  if (first === -1) return { preamble: src, blocks: [] };
  const preamble = src.slice(0, first);
  const rest = src.slice(first);
  const parts = rest.split(/\n(?=@__test__\()/);
  const blocks: Block[] = parts.map((text) => {
    const m = text.match(/@__test__\(\s*["'](.*?)["']/);
    return { name: m ? m[1] : "test", text };
  });
  return { preamble, blocks };
}

function compose(preamble: string, blocks: Block[]): string {
  return preamble.trimEnd() + "\n\n" + blocks.map((b) => b.text.trimEnd()).join("\n\n") + "\n";
}

async function main() {
  const dir = resolve(
    process.env.PRACTICE_PROBLEMS_DIR ||
      resolve(process.cwd(), "../prof-frontend/data/practice/problems")
  );
  if (!existsSync(dir)) {
    throw new Error(
      `Problems dir not found: ${dir}\nSet PRACTICE_PROBLEMS_DIR to the frontend data/practice/problems path.`
    );
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let imported = 0;
  let skipped = 0;

  for (const file of files) {
    const problem = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
    const slug: string = problem.slug;
    const harness: string = problem.tests || "";
    if (!slug || !harness.includes(TEST_MARKER)) {
      skipped++;
      continue;
    }

    const { preamble, blocks } = splitHarness(harness);
    if (blocks.length === 0) {
      skipped++;
      continue;
    }

    let sampleBlocks = blocks.filter((b) => SAMPLE_NAME.test(b.name));
    if (sampleBlocks.length === 0) sampleBlocks = [blocks[0]]; // always show at least one
    let hiddenBlocks = blocks.filter((b) => !sampleBlocks.includes(b));
    if (hiddenBlocks.length === 0) hiddenBlocks = blocks; // ensure Submit has a suite

    // Idempotent: replace this problem's tests.
    await prisma.problemTest.deleteMany({ where: { problemSlug: slug } });
    await prisma.problemTest.createMany({
      data: [
        {
          problemSlug: slug,
          order: 0,
          visibility: "SAMPLE",
          kind: "HARNESS",
          ioMode: "FUNCTION_CALL",
          checkerType: "CUSTOM",
          language: "python",
          harness: compose(preamble, sampleBlocks),
        },
        {
          problemSlug: slug,
          order: 1,
          visibility: "HIDDEN",
          kind: "HARNESS",
          ioMode: "FUNCTION_CALL",
          checkerType: "CUSTOM",
          language: "python",
          harness: compose(preamble, hiddenBlocks),
        },
      ],
    });
    imported++;
  }

  console.log(
    `✓ ProblemTest import: ${imported} problems imported, ${skipped} skipped (no harness). Source: ${dir}`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
