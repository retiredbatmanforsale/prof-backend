# Production migration runbook — university dashboards (gradebook · practice · ranking)

**Status:** prepared, NOT executed. Nothing here has touched production.
**Run by:** a human with prod DB creds, on a **clone first**, then prod.

## Why this is special

Locally the migration history is clean: a single migration
`0_baseline_university_runtime` whose end-state == the current `schema.prisma`
(`prisma migrate status` → up to date, `migrate diff` → no drift).

That single baseline is a *"CREATE everything"* migration. It is **perfect for a
fresh DB** (new staging/preview): just `prisma migrate deploy`.

It is **NOT directly deployable onto the existing prod DB**, because prod:
- was created/maintained with `prisma db push` (no `_prisma_migrations` history);
- already has the older tables (`users`, `organizations`, `assessments`,
  `assessment_assignments`, …);
- is **missing** everything the dashboard work added since the last push —
  `grade_components`, `grade_entries`, `practice_attempts`,
  `assessments.sectionId`, the `LessonProgress` Phase-3 columns, the
  `AssessmentAttempt` Phase-6 scoring columns, the `orgRole` fields, etc.;
- still **has** `assessment_assignments`, which Phase 8 drops.
- is missing the **one-student-one-cohort** unique on
  `section_students(organizationMemberId)` (added by migration
  `*_section_student_one_cohort`); the generated delta will include it.

Helper scripts in this dir:
- `generate_prod_delta.sh` — runs the diff below and sanity-checks the output.
- `duplicate_cohort_detector.mjs` — pre-flight for the one-cohort unique.
- `backfill_assessment_section.sql` — assessment→cohort link backfill (spliced).
- `backfill_legacy_orgs.mjs` — Phase B: flatten staff→FACULTY, default cohorts,
  attach un-cohorted students (idempotent, dry-run by default).

If you naively `migrate deploy` → it runs `CREATE TABLE "users"` → fails.
If you naively `migrate resolve --applied` the baseline → prod is marked done
but the new tables/columns never get created → `/grades`, `/practice`,
`/ranking` 500 in prod.

So we don't guess prod's exact state — we **diff the live prod DB against the
target schema** to get the exact delta, apply it (with a data backfill before
the one destructive drop), then adopt the baseline into history.

## Pre-reqs

- Prod connection string. Use the **direct (non-pooled)** URL for migrate/diff
  ops. The prod secrets live in the quarantine dir (see memory:
  `~/prof-secrets-quarantine/`), not in the repo.
- `pg_dump` / `psql` available.
- Do a **full backup** and run the whole thing on a **restored clone** first.

```bash
export PROD_DIRECT_URL='postgresql://...'   # direct, NOT the pgbouncer/pooled URL
pg_dump "$PROD_DIRECT_URL" -Fc -f prod_backup_$(date +%Y%m%d).dump
```

## Step 0 — one-cohort pre-flight (BLOCKING)

The delta creates a UNIQUE index on `section_students(organizationMemberId)`. It
will **fail** if any student is already in >1 cohort. Detect first — it only
prints, never deletes:

```bash
DATABASE_URL="$PROD_DIRECT_URL" node prisma/prod-deploy/duplicate_cohort_detector.mjs
```

Exit 0 = clean, proceed. Exit 1 = duplicates printed — a human picks the cohort
to keep and deletes the other `section_students` row(s) **manually**, then re-run
until clean. Do NOT auto-delete.

## Step 1 — generate the exact delta prod is missing

```bash
cd ~/Documents/prof/prof-backend
PROD_DIRECT_URL="$PROD_DIRECT_URL" prisma/prod-deploy/generate_prod_delta.sh
# → writes prisma/prod-deploy/prod_delta.generated.sql and grep-checks the 8
#   expected items. (Equivalent to: prisma migrate diff --from-url "$PROD_DIRECT_URL"
#   --to-schema-datamodel prisma/schema.prisma --script.)
```

This is read-only against prod (introspect only) and produces the precise SQL to
bring prod up to `schema.prisma`, whatever prod's current state is — no guessing.

## Step 2 — REVIEW the delta (the important part)

Open `prod_delta.generated.sql` and check every statement. Specifically:

- **`CREATE UNIQUE INDEX "section_students_organizationMemberId_key"`** — confirm
  it's there (the one-cohort guarantee). Step 0 must have passed first.

- **`DROP TABLE "assessment_assignments"`** — confirm it's there. To avoid losing
  assessment→cohort links, splice in `backfill_assessment_section.sql` so it runs
  **after** `ALTER TABLE "assessments" ADD COLUMN "sectionId"` and **before** the
  `DROP TABLE "assessment_assignments"`. (The backfill is self-guarding and
  idempotent.)
- Any **other `DROP` / `ALTER ... DROP COLUMN`** — confirm no column you still
  need is being removed. New columns added by the dashboard work should all be
  nullable or have defaults (additive) — verify there are no `NOT NULL` adds on
  populated tables without a default.
- Enum creates (`GradeComponentType`, `GradeSource`) and new tables
  (`grade_components`, `grade_entries`, `practice_attempts`) should be CREATEs.

## Step 3 — dry run on a clone

Restore the backup into a scratch DB, point `DATABASE_URL` at it, apply the
spliced delta, then boot the backend and smoke-test `/grades`, `/practice`,
`/ranking`, and an assessment that previously had a cohort assignment (confirm
its `sectionId` survived the backfill).

```bash
psql "$CLONE_URL" -1 -v ON_ERROR_STOP=1 -f prisma/prod-deploy/prod_delta.generated.sql
```

## Step 4 — apply to prod (transactional)

```bash
psql "$PROD_DIRECT_URL" -1 -v ON_ERROR_STOP=1 -f prisma/prod-deploy/prod_delta.generated.sql
```

`-1` wraps it in a single transaction; `ON_ERROR_STOP=1` aborts (and rolls back)
on the first error.

## Step 5 — adopt the baseline into migration history

After Step 4, prod's schema == `schema.prisma` == the baseline's end-state, so we
can mark the baseline as already-applied (this only writes the `_prisma_migrations`
bookkeeping row; it runs no DDL):

Mark **every** migration in `prisma/migrations/` as applied (the baseline AND the
`*_section_student_one_cohort` migration — both end-states are now present in
prod):

```bash
for m in prisma/migrations/*/; do
  name=$(basename "$m")
  DATABASE_URL="$PROD_DIRECT_URL" npx prisma migrate resolve --applied "$name"
done
```

## Step 6 — verify

```bash
DATABASE_URL="$PROD_DIRECT_URL" npx prisma migrate status   # → "up to date"
```

From here, all future prod releases are the normal one-liner: add migrations with
`prisma migrate dev` locally, ship with `prisma migrate deploy` on prod.

## Step 7 — Phase B legacy-org backfill (data, after the schema is migrated)

Schema is now correct but old "flat" universities still have no cohorts and
mixed staff roles. Flatten staff → FACULTY, create a "Default Cohort" per org,
and attach un-cohorted students. Idempotent; dry-run first:

```bash
DATABASE_URL="$PROD_DIRECT_URL" node prisma/prod-deploy/backfill_legacy_orgs.mjs           # DRY-RUN
DATABASE_URL="$PROD_DIRECT_URL" node prisma/prod-deploy/backfill_legacy_orgs.mjs --apply    # write
```

Re-running is safe (no-op once everything is cohorted and flattened). This step
runs AFTER Step 4 so the one-cohort unique is already enforced — `createMany`
skips any student who somehow already has a cohort.

## Rollback

If anything fails mid-way, the `-1` transaction rolls back automatically. If a
problem surfaces after commit, restore `prod_backup_<date>.dump`.
