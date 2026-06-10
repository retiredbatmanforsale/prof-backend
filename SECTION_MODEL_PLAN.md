# Section Model + Faculty API — Plan

> Companion to `prof-frontend/UNI_DASHBOARD_POC.md`. Backend design for wiring
> the POC's L1/L2 (campus admin manages cohorts; faculty sees only assigned
> cohorts) to real data. Builds on the `OrgRole` work (see `src/lib/orgRole.ts`
> and the `orgrole-rollout` memory).
>
> **Status:** Phases 1 & 2 DONE on the `long-dream` branch; Phase 3 (wire
> frontend) pending.
>
> - **Phase 1** — 3 tables (`scripts/add-sections.sql`), `computeSectionMetrics`,
>   `requireFaculty`, `GET /faculty/sections(/:id/metrics)`,
>   `GET /org/sections(/:id/metrics)`.
> - **Phase 2** — `PreloadedStudent.sectionId` (`scripts/add-preloaded-section.sql`)
>   + claim-flow linking (`lib/sections.ts`, wired into register/login/google/
>   accept-invite); write endpoints `POST /org/sections`, `/sections/:id/assign`,
>   `DELETE /sections/:id/assign/:memberId`, `POST /sections/:id/students`,
>   `POST /sections/bulk` (roster CSV).
> - Verified: tsc clean, 27 tests green, end-to-end smoke test (create→link→
>   metrics→cleanup) passed against the branch.
> - **Phase 3** (frontend, in `prof-frontend`) — IN PROGRESS. Done:
>   - `orgRole` surfaced in `contexts/AuthContext.tsx`; "My Sections" / "Org
>     Dashboard" nav entries gated by tier.
>   - `services/sections.ts` — full typed client for every org + faculty
>     endpoint (+ `listOrgMembers`); shared `components/org/CohortMetricsView.tsx`.
>   - **Faculty (L2):** `app/faculty/page.tsx` — assigned sections → cohort
>     drilldown.
>   - **Campus admin (L1):** `components/org/SectionsManager.tsx`, mounted as a
>     "Sections" tab on `app/org/page.tsx` — list/create sections, roster CSV
>     upload, assign/unassign staff, cohort drilldown. Backed by a new
>     `GET /org/members` endpoint (`src/routes/org/members.ts`).
>   - tsc clean (frontend + backend), 27 backend tests green.
>   - Remaining: retire the `/org/preview/uni` mock tree once L0–L2 are confirmed
>     in the real UI; optional manual student-add picker (CSV already covers bulk).

---

## 1. Data model (3 new tables, all additive)

The POC's `Section { id, name, course, assignedStaffIds[] }` + `Student { sectionId }`
maps to one table + two join tables, all tied to the canonical
`OrganizationMember` so metrics reuse the existing user-id resolution.

```prisma
model Section {
  id             String   @id @default(cuid())
  organizationId String
  name           String              // "CSE-A 2026"
  course         String?             // optional label from CSV
  createdViaCsv  Boolean  @default(false)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  organization Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  students     SectionStudent[]
  staff        SectionAssignment[]

  @@unique([organizationId, name])
  @@index([organizationId])
  @@map("sections")
}

// A student member belongs to a section (cohort). Many-to-many so a student
// can be in multiple sections without a schema change.
model SectionStudent {
  id                   String @id @default(cuid())
  sectionId            String
  organizationMemberId String

  section Section            @relation(fields: [sectionId], references: [id], onDelete: Cascade)
  member  OrganizationMember @relation(fields: [organizationMemberId], references: [id], onDelete: Cascade)

  @@unique([sectionId, organizationMemberId])
  @@index([organizationMemberId])
  @@map("section_students")
}

// A faculty/TA member assigned to a section. This is what scopes L2.
model SectionAssignment {
  id                   String   @id @default(cuid())
  sectionId            String
  organizationMemberId String
  assignedAt           DateTime @default(now())
  assignedByUserId     String?

  section Section            @relation(fields: [sectionId], references: [id], onDelete: Cascade)
  member  OrganizationMember @relation(fields: [organizationMemberId], references: [id], onDelete: Cascade)

  @@unique([sectionId, organizationMemberId])
  @@index([organizationMemberId])
  @@map("section_assignments")
}
```

Back-relations: `OrganizationMember` gains `sectionStudentOf SectionStudent[]`
and `sectionAssignments SectionAssignment[]`; `Organization` gains
`sections Section[]`.

**Why join tables, not `OrganizationMember.sectionId`:** a student can be in
multiple cohorts and a faculty member teaches multiple sections — both are
inherently many-to-many. Tying to `OrganizationMember` (not `User`) keeps
section membership inside the org boundary.

**Invariant (app-enforced, not FK):** a section's students and staff must belong
to the same org as the section. Validated on every assign/add.

## 2. Metrics — make `computeOrgMetrics` cohort-generic

Split the existing `computeOrgMetrics(prisma, orgId, orgName)`:

- `computeCohortMetrics(prisma, { userIds, organizationId, organizationName, sectionId?, sectionName? })`
  — the shared math (unchanged output shape).
- `computeOrgMetrics` → resolves org-wide `orgRole: STUDENT` members, delegates.
- `computeSectionMetrics(prisma, sectionId)` → resolves the section's
  `SectionStudent` members (active, `orgRole STUDENT`), delegates.

Output gains optional `sectionId`/`sectionName`; otherwise identical to today's
`OrgMetrics`, so the frontend `CohortDashboard` / `MetricCompareCard` /
`LearnerCards` reuse unchanged (matches the POC `cohortMetrics()` contract).

## 3. Guard: `requireFaculty`

Mirrors `requireOrgAdmin` (authoritative DB re-check, never trusts JWT):

```
- 401 if unauthenticated
- resolve caller's active faculty-tier membership (orgRole ∈ FACULTY_TIER_ROLES)
  in an active, in-window org
- 403 if none
- set request.facultyContext = { organizationId, organizationName, memberId }
```

Per-section authorization is checked in the handler against `SectionAssignment`
for `facultyContext.memberId` — a faculty hitting an unassigned section → 403.

## 4. Endpoints

**Campus-admin management** — under `/org/*` (`requireOrgAdmin`, org-scoped via `orgAdminContext`):

| Method | Route | Purpose | Phase |
|---|---|---|---|
| `GET`    | `/org/sections`                      | list all sections (+ staff, student counts) | 1 |
| `GET`    | `/org/sections/:id/metrics`          | cohort metrics for one section | 1 |
| `POST`   | `/org/sections`                      | create a section | 2 |
| `POST`   | `/org/sections/bulk`                 | CSV create sections + students | 2 |
| `POST`   | `/org/sections/:id/students`         | add students | 2 |
| `POST`   | `/org/sections/:id/assign`           | assign a staff member | 2 |
| `DELETE` | `/org/sections/:id/assign/:memberId` | unassign | 2 |

**Faculty surface** — new `/faculty/*` group (`authenticate` + `requireFaculty`):

| Method | Route | Purpose | Phase |
|---|---|---|---|
| `GET` | `/faculty/sections`             | only sections assigned to the caller | 1 |
| `GET` | `/faculty/sections/:id/metrics` | metrics for an assigned section (else 403) | 1 |

L0 (platform admin) already reaches any org via `?asOrg=` on `/org`; an
analogous `?asStaff=` for previewing a faculty's view is optional/future.

## 5. CSV (reuses POC `csv.ts` semantics)

`POST /org/sections/bulk` parses header `campus, section, course, studentName,
studentEmail`; rows sharing campus+section group into one `Section`; each student
row upserts `PreloadedStudent` (orgRole STUDENT) + links via `SectionStudent`.
Staff CSV (`name, email[, role]`) extends the existing bulk-admin path to set the
faculty-tier `orgRole` and optionally pre-assign a section.

## 6. Migration & rollout

Additive only — 3 new tables, zero changes to existing tables; safe against prod.

1. `scripts/add-sections.sql` — `CREATE TABLE` ×3 + indexes, idempotent (`IF NOT EXISTS`).
2. Apply to the `long-dream` branch via `prisma db execute`; `npm run db:generate`.
3. Per the `orgrole-rollout` memory: run on prod **before** deploying the code.
   No `user_streak` risk (new tables only); never `db:push`.

## 7. Phasing

- **Phase 1 — schema + read path:** 3 tables, `computeSectionMetrics`,
  `requireFaculty`, `GET /faculty/*`, `GET /org/sections` + `GET /org/sections/:id/metrics`.
- **Phase 2 — management:** create/assign/unassign + bulk CSV.
- **Phase 3 — wire frontend:** swap POC `UniContext` mock state for these endpoints
  (POC merge-plan steps 2–5).
