import { OrgRole, type Prisma } from "@prisma/client";

/**
 * Per-organization access tiers. `orgRole` (on OrganizationMember /
 * PreloadedStudent) is the canonical tier. The legacy `isOrgAdmin` boolean is
 * kept in lockstep with CAMPUS_ADMIN during the transition: every write sets
 * both, and the admin-gate reads tolerate a row where only one is set (see
 * `campusAdminMembershipWhere`). Once all environments are migrated +
 * backfilled and nothing reads `isOrgAdmin`, the boolean can be dropped.
 */

// Teaching staff scoped to assigned sections — distinct from CAMPUS_ADMIN
// (full org visibility) and STUDENT (a learner).
export const FACULTY_TIER_ROLES: readonly OrgRole[] = [
  OrgRole.FACULTY,
  OrgRole.LAB_ASSISTANT,
  OrgRole.TA,
];

export function isCampusAdminRole(role: OrgRole | null | undefined): boolean {
  return role === OrgRole.CAMPUS_ADMIN;
}

export function isFacultyTierRole(role: OrgRole | null | undefined): boolean {
  return !!role && FACULTY_TIER_ROLES.includes(role);
}

/**
 * FLAT HIERARCHY: every non-student org role is "staff" and gets the single
 * faculty runtime surface. CAMPUS_ADMIN, FACULTY, LAB_ASSISTANT and TA are all
 * treated identically for runtime ACCESS — there is no campus-admin/faculty
 * split anymore. (Legacy enum values are kept for migration compatibility; new
 * staff are all written as FACULTY.) STUDENT is the only non-staff tier.
 */
export const STAFF_ROLES: readonly OrgRole[] = [
  OrgRole.CAMPUS_ADMIN,
  OrgRole.FACULTY,
  OrgRole.LAB_ASSISTANT,
  OrgRole.TA,
];

export function isStaffRole(role: OrgRole | null | undefined): boolean {
  return !!role && STAFF_ROLES.includes(role);
}

/**
 * Membership filter that counts as a campus admin, tolerant of rows where only
 * the legacy `isOrgAdmin` boolean OR only the new `orgRole` is set. Spread into
 * an OrganizationMember `where` alongside the other (AND-ed) conditions.
 */
export const campusAdminMembershipWhere = {
  OR: [{ isOrgAdmin: true }, { orgRole: OrgRole.CAMPUS_ADMIN }],
} satisfies Prisma.OrganizationMemberWhereInput;

/**
 * Membership filter for ANY org staff member (flat hierarchy). Matches the
 * legacy isOrgAdmin boolean or any non-student orgRole. This is the single
 * gate for the /faculty runtime surface.
 */
export const staffMembershipWhere = {
  OR: [{ isOrgAdmin: true }, { orgRole: { in: [...STAFF_ROLES] } }],
} satisfies Prisma.OrganizationMemberWhereInput;

/**
 * Org filter: active and within its access window as of `now`. Reused by every
 * lookup that resolves a user's live org scope.
 */
export function activeOrgWhere(now: Date): Prisma.OrganizationWhereInput {
  return {
    isActive: true,
    OR: [{ accessStartDate: null }, { accessStartDate: { lte: now } }],
    AND: {
      OR: [{ accessEndDate: null }, { accessEndDate: { gte: now } }],
    },
  };
}
