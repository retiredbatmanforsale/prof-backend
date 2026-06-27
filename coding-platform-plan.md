# Coding Platform — Submission & Evaluation (Build Plan)

Owner: Puru. Status: proposed. Merges the team's "PROF Compiler + Judge System Design" (Arpit, 2026-06-26, audited against the live codebase) with the Piston engine lock + cost analysis. **Engine: Piston, self-hosted on GCP (locked).**

Goal: one shared code-submission + evaluation service for **/practice** and **assessment coding questions**, used identically by B2C and B2B. Delivers: store code, track problems solved, track tests passed/failed, multi-language, on the existing Monaco editor.

## Core decision (locked): dedicated executor service
- **`prof-executor`** = a second Cloud Run service running **Piston**. `prof-backend` keeps all orchestration, storage, auth, tenancy, grading, analytics. The executor is a **locked box: no DB, no secrets, no network egress, concurrency=1**, warm pool `min-instances=1-2`.
- **Why not in-process:** untrusted code next to the Neon/JWT/Razorpay/Anthropic secrets is a security non-starter regardless of scale; a CPU-bound run would block the single-threaded Fastify API; execution and API scale on different curves. A sandbox escape in the locked executor yields nothing.
- **Engine-agnostic contract** (Piston now, swappable later):
  `prof-backend → POST /execute {language, code, tests[], limits} → prof-executor → {verdict, perTest[], runtimeMs, memoryKb, stdout, stderr}`. Service-to-service auth (Cloud Run OIDC / shared secret).
- **Hidden tests live only in the backend/DB.** The backend builds the harness (student code + hidden tests), sends the combined program to the executor, parses the verdict. The browser never sees hidden tests.

## One judge for B2C + B2B
Same engine and same analytics (percentile, history, runtime, streaks, LeetCode-style) for a free D2C learner and a university student. Only **governance** differs: B2B adds faculty review, locked grades, semester retention. At B2C scale you tier and prune storage harder (see Defer list). Do not build two systems.

## Run vs Submit (+ two golden rules)
| | Run | Submit |
|---|---|---|
| Tests | sample / visible | full hidden suite |
| Where | browser (Pyodide) | `prof-executor` (authoritative) |
| Stored? | No | Yes (one `CodeSubmission`) |
| Counts (solved / graded)? | No | Yes |

- **Submit is server-side for BOTH practice and assessments.** Client-asserted "solved" is gameable, so a trusted solved/percentile signal requires the executor. Run stays in the browser (free, instant).
- **Rule 1:** never read the `code` blob in list/dashboard queries. Keep a small **summary table**; fetch the code only on a single detail page.
- **Rule 2:** store only **Submit**, never **Run** (Run is the high-frequency action; storing it is the main scaling mistake).

## Execution model
- **Function-based primary** (reuse the existing `@__test__` Python harness verbatim) + **stdin/stdout secondary**, declared per-problem (`harnessType`).
- **Numeric tolerance for ML** (`numpy allclose`): exact string/equality match is wrong for arrays/tensors. Non-negotiable for the AI/ML problems.
- Sample tests run client (Pyodide); the **same** harness + appended hidden tests run server (executor). One test format, two locations.

## Storage
```prisma
// Append-only, immutable. One row per SUBMIT. (Versioning/history falls out free.)
model CodeSubmission {
  id            String   @id @default(cuid())   // time-sortable id (e.g. cuid2/ulid)
  userId        String
  organizationId String? // denormalized at write for tenancy + reporting (null for B2C)
  sectionId     String?
  kind          String   // PRACTICE_SUBMIT | ASSESSMENT_SUBMIT
  problemSlug   String?  // practice
  assessmentId  String?  // assessment
  questionId    String?  // assessment question
  language      String
  code          String   // full source (cap 256 KB) — NEVER selected in list queries
  testVersion   String?  // hash of the test set that graded it (dispute integrity)
  verdict       String   // ACCEPTED | WRONG_ANSWER | TLE | MLE | RUNTIME_ERROR | COMPILE_ERROR
  passedCount   Int      @default(0)
  totalCount    Int      @default(0)
  score         Float?   // weighted, graded contexts
  maxScore      Float?
  runtimeMs     Int?
  memoryKb      Int?
  stdout        String?  // cap 64 KB
  stderr        String?  // cap 64 KB
  createdAt     DateTime @default(now())
  testResults   SubmissionTestResult[]
  @@index([userId, problemSlug])
  @@index([assessmentId, userId, questionId])
  @@index([organizationId, sectionId])
  @@index([problemSlug, verdict])   // percentile / solve-rate
}
```
- **Summary table** (or a narrow projection) drives lists/dashboards/profiles without touching `code`.
- **Solved** = exists a Submit with `verdict = ACCEPTED` for (user, problem). Keep `PracticeAttempt.solved` as a denormalized cache.
- **Tests passed/failed** = `passedCount / totalCount` (+ `SubmissionTestResult` or a `perTest` JSON for the breakdown).
- Caps: source 256 KB, stdout/stderr 64 KB. Time-sortable IDs. Use the Neon connection pooler.

## Cost (Piston is free software; GCP is the only cost)
- **Per-submit: effectively free at this scale.** A submit runs ~2-3s on ~1 vCPU; Cloud Run's free tier (~180k vCPU-s/mo) covers ~60k submits/mo. Beyond it, ~8 cents / 1,000 submits.
- **Warm pool is the real line item.** `concurrency=1` means more instances, so to avoid cold starts on Submit keep `min-instances=1-2` (~$25-60/mo), OR scale-to-zero (~$0, cold-start latency), OR warm only during scheduled exam windows.
- **Rate-limit Submit** (cost + abuse + standard UX): per-user/per-problem cooldown, the existing assessment `attemptPolicy` cap, and a global ceiling on the executor endpoint. Backend already uses Fastify per-route rate limits.

## Do now (cheap) vs defer (until real numbers)
- **Do now:** locked `prof-executor`, Postgres submit storage, 256 KB cap, submit rate-limit, summary table, time-sortable IDs, connection pooler.
- **Defer:** object storage for code blobs, table partitioning, execution queue, precomputed percentiles, plagiarism/similarity.

## Phased build
| Phase | Deliverable | Effort |
|---|---|---|
| 0 | Stand up `prof-executor` (Piston on Cloud Run, locked: no DB/secrets/egress, conc=1, warm pool) + the `/execute` contract. Spike Python + JS + an ML numeric-tolerance case; confirm latency, isolation, warm-pool cost. | spike |
| 1 | `CodeSubmission` + summary table + per-test rows. Grade **assessment** coding via executor → `passed/total × points` → existing `writeAutoGradeEntries` → gradebook. (Coding stops being manual/pendingReview.) | L |
| 2 | **/practice** Submit → executor (trusted solved) + `CodeSubmission`; keep Pyodide for Run; multi-language; wire `ProblemSolver`. | M |
| 3 | More languages (C++/Java); Monaco autocomplete config; then the deferred items (percentiles, plagiarism) when numbers justify. | M |

Each phase gets Neon-branch behavior verification (seed → submit correct + wrong → assert verdict, per-test counts, `CodeSubmission` row, attempt score, gradebook entry).

## Open (smaller) decisions
1. Per-test storage: separate `SubmissionTestResult` table (queryable) vs `perTest` JSON (simpler).
2. Launch languages: Python + JavaScript (default); add C++/Java in Phase 3.
3. Warm-pool policy: always-on `min-instances=1` (~$25/mo) vs warm-only-during-exam-windows.

## Cross-references
- Arpit's source doc covers later sections not yet merged here (Part II storage tiering/pruning at B2C scale, failure modes, percentile precomputation). Fold those in when reviewing pages 7-21.
