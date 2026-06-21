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

## Step 1 — generate the exact delta prod is missing

```bash
cd ~/Documents/prof/prof-backend
npx prisma migrate diff \
  --from-url "$PROD_DIRECT_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/prod-deploy/prod_delta.sql
```

This is read-only against prod (introspect only) and produces the precise SQL to
bring prod up to `schema.prisma`, whatever prod's current state is.

## Step 2 — REVIEW the delta (the important part)

Open `prod_delta.sql` and check every statement. Specifically:

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
psql "$CLONE_URL" -1 -v ON_ERROR_STOP=1 -f prisma/prod-deploy/prod_delta.sql
```

## Step 4 — apply to prod (transactional)

```bash
psql "$PROD_DIRECT_URL" -1 -v ON_ERROR_STOP=1 -f prisma/prod-deploy/prod_delta.sql
```

`-1` wraps it in a single transaction; `ON_ERROR_STOP=1` aborts (and rolls back)
on the first error.

## Step 5 — adopt the baseline into migration history

After Step 4, prod's schema == `schema.prisma` == the baseline's end-state, so we
can mark the baseline as already-applied (this only writes the `_prisma_migrations`
bookkeeping row; it runs no DDL):

```bash
DATABASE_URL="$PROD_DIRECT_URL" npx prisma migrate resolve \
  --applied 0_baseline_university_runtime
```

## Step 6 — verify

```bash
DATABASE_URL="$PROD_DIRECT_URL" npx prisma migrate status   # → "up to date"
```

From here, all future prod releases are the normal one-liner: add migrations with
`prisma migrate dev` locally, ship with `prisma migrate deploy` on prod.

## Rollback

If anything fails mid-way, the `-1` transaction rolls back automatically. If a
problem surfaces after commit, restore `prod_backup_<date>.dump`.
