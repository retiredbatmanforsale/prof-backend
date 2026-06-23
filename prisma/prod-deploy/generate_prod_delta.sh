#!/usr/bin/env bash
# PHASE D — generate the REAL prod delta. The authoritative delta can only come
# from the LIVE production database (no two db-push'd envs are byte-identical),
# so we let Prisma diff prod against the target schema. NO hand-authoring, NO
# guessing about prod's current column/table state.
#
# Output: prod_delta.generated.sql — the exact forward SQL to bring prod up to
# prisma/schema.prisma. Review it, splice the backfill (see RUNBOOK), dry-run on
# a restored clone, THEN apply to prod in a transaction.
#
# Requires: PROD_DIRECT_URL pointing at the prod Postgres (direct, non-pooled).
# Creds live in ~/prof-secrets-quarantine/ — export them in your shell, do not
# commit them.
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root (prisma/ is here)

: "${PROD_DIRECT_URL:?Set PROD_DIRECT_URL to the prod direct connection string}"

OUT="prisma/prod-deploy/prod_delta.generated.sql"

echo ">> Diffing PROD against prisma/schema.prisma ..."
npx prisma migrate diff \
  --from-url "$PROD_DIRECT_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script > "$OUT"

echo ">> Wrote $OUT"
echo
echo ">> Sanity check — the generated delta MUST contain these 8 items:"
echo "   (grep results; empty = MISSING, investigate before applying)"
for needle in \
  'grade_components' \
  'grade_entries' \
  'practice_attempts' \
  'assessments".*"sectionId"|"sectionId".*assessments' \
  'assessment_attempts".*"score"|"score"|"submittedAt"|"pendingReview"' \
  'section_students_organizationMemberId_key' \
  'DROP TABLE "assessment_assignments"' ; do
  printf '   [%s] ' "$needle"
  grep -Eic "$needle" "$OUT" || true
done
echo
echo ">> NEXT (see RUNBOOK.md):"
echo "   1. Run duplicate_cohort_detector.mjs against PROD — must exit 0."
echo "   2. Splice backfill_assessment_section.sql into $OUT AFTER the"
echo "      'ADD COLUMN \"sectionId\"' on assessments and BEFORE"
echo "      'DROP TABLE \"assessment_assignments\"'."
echo "   3. Dry-run on a restored clone, then apply to prod in one txn:"
echo "      psql \"\$PROD_DIRECT_URL\" -1 -v ON_ERROR_STOP=1 -f $OUT"
echo "   4. prisma migrate resolve --applied <each migration in prisma/migrations>"
