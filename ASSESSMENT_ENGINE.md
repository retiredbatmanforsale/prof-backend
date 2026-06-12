# Assessment Engine — v1 vertical slice

> Companion to `SECTION_MODEL_PLAN.md`. Builds directly on the OrgRole +
> Section (cohort) work from PR #10 (`feature/universityadmin`). This branch
> (`feature/assessment-engine`) is cut from that branch because the engine
> depends on `OrgRole.FACULTY` and the `Section` model.
>
> **In scope:** faculty create assessment → add questions → assign cohorts →
> save/publish; students view assigned assessments.
> **Out of scope (intentionally):** evaluation, grading, plagiarism, reports,
> analytics, code execution (Judge0/Piston), assessment confidence. Questions
> are stored but never run or scored.

## Data model (3 new tables, additive only)

- **`Assessment`** — authored by a faculty `OrganizationMember`
  (`createdByMemberId`), owned by an org. Lifecycle `status`: `DRAFT` →
  `PUBLISHED`. `PUBLISHED` is the only state students can see.
- **`AssessmentQuestion`** — ordered children (`order`, 0-based). Either:
  - `kind = CATALOG` — references a practice problem by `catalogSlug` (the
    catalog lives in the **frontend** filesystem, `prof-frontend/
    lib/practice/loader.ts`). `content` holds a lightweight snapshot
    (`difficulty`, `topics`) so lists render server-side without the catalog.
  - `kind = CUSTOM` — authored inline; `content` is `{ type, prompt, options?,
    correctIndex?, ... }`. Answer keys are stored but stripped from student
    payloads (`serializeQuestionForStudent`).
- **`AssessmentAssignment`** — M:N join `Assessment ↔ Section`. This is
  "assign cohorts". `@@unique([assessmentId, sectionId])`.

Back-relations: `Organization.assessments`, `OrganizationMember.assessmentsAuthored`,
`Section.assessmentAssignments`.

## Authorization

- **Faculty surface** `/faculty/assessments*` — gated by `requireFaculty`
  (parent `faculty/index.ts`), scoped to `facultyContext.memberId`.
  - A faculty member manages only the assessments they authored.
  - Cohort assignment is validated against `SectionAssignment`: a faculty
    member can only assign to sections they teach (`assertSectionsTeachable`).
- **Student surface** `/assessments*` — gated by `authenticate` only. A student
  sees an assessment iff it is `PUBLISHED` **and** assigned to a `Section` they
  are a `SectionStudent` of. Resolution is the inverse of authoring:
  `SectionStudent → AssessmentAssignment → PUBLISHED Assessment`.

## Endpoints

Faculty (`requireFaculty`):

| Method | Route | Purpose |
|---|---|---|
| `GET`    | `/faculty/assessments`            | list assessments authored by caller |
| `POST`   | `/faculty/assessments`            | create (composite: meta + questions[] + sectionIds[]) |
| `GET`    | `/faculty/assessments/:id`        | full detail (questions + assigned cohorts) |
| `PATCH`  | `/faculty/assessments/:id`        | composite save — questions/sectionIds REPLACE the set |
| `POST`   | `/faculty/assessments/:id/publish`| DRAFT → PUBLISHED |
| `DELETE` | `/faculty/assessments/:id`        | delete |

Student (`authenticate`):

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/assessments`     | PUBLISHED assessments assigned to the caller's cohorts |
| `GET` | `/assessments/:id` | one assessment (answer keys stripped) |

**Composite save:** the body carries the full intended state. On `PATCH`,
`questions` and `sectionIds` (when present) replace the existing rows in a
single `$transaction`. This matches the frontend "build in the UI, then Save"
flow.

## Migration & rollout

Additive only — 3 new tables + 2 enums (`AssessmentStatus`, `QuestionKind`),
zero changes to existing tables.

1. `scripts/add-assessments.sql` — idempotent `CREATE TYPE` / `CREATE TABLE IF
   NOT EXISTS` + indexes + FKs (guarded on `pg_constraint`). Same pattern as
   `add-sections.sql`. Depends on the section + org-role scripts being applied.
2. Apply with `prisma db execute --file scripts/add-assessments.sql`, then
   `npm run db:generate`. Per the `orgrole-rollout` convention: run on the DB
   **before** deploying the code; never `db:push`.

## Frontend (prof-frontend, `feature/assessment-engine`)

- `services/assessments.ts` — typed client for every endpoint + the catalog.
- `app/api/practice-catalog/route.ts` — exposes the fs-backed catalog to the
  client builder.
- Faculty: `app/faculty/assessments/` (list, `new`, `[id]`) +
  `components/assessments/AssessmentBuilder.tsx` (meta, question editor,
  catalog picker, cohort multi-select, save/publish).
- Student: `app/assessments/` (list, `[id]`) +
  `components/assessments/StudentAssessmentView.tsx` (read-only).
- `contexts/AuthContext.tsx` gained `orgRole`; nav links gated by faculty tier.
