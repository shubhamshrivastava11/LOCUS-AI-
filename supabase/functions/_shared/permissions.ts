// The access rule, in one place.
//
// A record is visible to a caller when ALL of these hold:
//
//   (1) record.tenant_id = caller.tenant_id                   tenancy
//   (2) record.permission_scope INTERSECTS scopes(caller)     scope
//   (3) record.classification  <= clearance(caller)           clearance
//   (4) NOT personal_source_violation(record, caller)         personal
//
// (1) is the RLS boundary and is enforced by the transaction-local
// app.current_tenant_id GUC - it never reaches this file. (4) lives in SQL on
// the list and by-id paths and in visibleRecordIds() for MCP, because it is a
// join against source_connections rather than a property of the record. (2)
// and (3) are here.
//
// They are joined by AND, and the consequence is the single most important
// thing to understand about the hierarchy, because the word invites the
// opposite assumption: a higher role does not widen what you can REACH. It
// only lets you see more sensitive material inside places you already belong.
// An Owner who was never added to a private channel sees nothing from it, at
// any classification. Seniority buys clearance, never scope.
//
// This module exists because the predicate used to be written inline in
// api/index.ts and nowhere else, so /decisions, /decisions/:id and MCP - three
// routes that return the same rows - never ran the scope check at all. One
// implementation is the only arrangement that stops that recurring.

import { withAdmin, withTenant } from "./db.ts";
import { resolvePermissionScopes, visibleRecordIds } from "./tenantAuth.ts";

// ── Clearance ────────────────────────────────────────────────────────────

/**
 * What sensitivity level each role may read. Note that Owner and Admin have
 * the SAME clearance: administration is not readership. An Admin configures
 * connectors, manages members and sets policy, and none of that requires
 * reading personnel records. Keeping the administrative capability and the
 * reading clearance separate is what stops this rebuilding the blast-radius
 * problem one level down.
 *
 *   3 Confidential  (additionally requires an explicit per-scope grant)
 *   2 Restricted
 *   1 Internal      the default every extracted record starts at
 *   0 Public
 */
export function clearanceForLevel(roleLevel: number): number {
  if (roleLevel >= 4) return 3; // Owner, Admin
  if (roleLevel === 3) return 2; // Lead
  if (roleLevel === 2) return 1; // Member
  return 0; // Guest, and anything unrecognised
}

export const CLASSIFICATION_NAMES = ["Public", "Internal", "Restricted", "Confidential"];

/** Confidential. Clearance alone is never enough for this level. */
export const CONFIDENTIAL = 3;

/** Member. A Guest is never admitted to Confidential, grant or not. */
const MIN_LEVEL_FOR_CONFIDENTIAL = 2;

// ── Scope membership ─────────────────────────────────────────────────────

const SLACK_CHANNEL_RE = /^C[A-Z0-9]{8,}$/;
const NOTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A scope id that names a container we may or may not have membership for. */
export function isUnmappedScope(scope: string): boolean {
  return SLACK_CHANNEL_RE.test(scope) || NOTION_ID_RE.test(scope);
}

/**
 * `known` is every scope we hold ANY membership data for; `memberOf` is the
 * subset the caller is actually in.
 *
 * The distinction is the whole safety mechanism. A scope that has never been
 * synced stays on the old permissive behaviour, so turning membership
 * enforcement on could not retroactively hide content people were correctly
 * seeing. Coverage tightens by itself as slack-membership-sync fills the table
 * in.
 *
 * That fallback applies to condition (2) and to NOTHING else. It is never
 * extended to clearance: clearance is computed from the caller's own role,
 * which is always known, so there is no missing-data case to fall back from.
 * A fallback there would mean an unclassified record defaulting open, and the
 * Internal default already covers that safely.
 */
export type ScopeAccess = { known: Set<string>; memberOf: Set<string> };

export const EMPTY_SCOPE_ACCESS: ScopeAccess = { known: new Set(), memberOf: new Set() };

/**
 * Loads membership for every scope in the tenant, not just the ones a
 * particular result page happens to mention.
 *
 * The earlier per-candidate version could only be used where the candidate
 * scopes were known before the query ran, which is why /decisions - paginated
 * in SQL - never got the check. Tenant-wide is one row per channel, which is
 * small enough that the difference does not matter (63 rows across every
 * tenant in production as of 15 Sep 2026).
 */
export async function loadScopeAccess(
  tenantId: string,
  email: string | null,
): Promise<ScopeAccess> {
  try {
    const rows = await withTenant(tenantId, async (sql) => {
      return await sql`
        select external_scope_id,
               bool_or(lower(member_email) = lower(${email ?? ""})) as is_member
        from public.source_scope_members
        where tenant_id = ${tenantId}::uuid
        group by external_scope_id
      `;
    });
    const known = new Set<string>();
    const memberOf = new Set<string>();
    for (const row of rows as unknown as { external_scope_id: string; is_member: boolean }[]) {
      known.add(row.external_scope_id);
      if (row.is_member) memberOf.add(row.external_scope_id);
    }
    return { known, memberOf };
  } catch (err) {
    // Fail OPEN on a lookup error rather than locking a tenant out of their own
    // memory because one table is briefly unavailable. The deny path below only
    // ever engages on data we successfully read, so an empty result is
    // indistinguishable from "nothing synced yet" and lands on the same
    // permissive branch. Clearance is unaffected either way.
    console.error("scope membership lookup failed, falling back to legacy behaviour:", err);
    return EMPTY_SCOPE_ACCESS;
  }
}

// ── The caller ───────────────────────────────────────────────────────────

export type CallerAuthz = {
  userId: string;
  tenantId: string;
  email: string | null;
  role: string;
  roleLevel: number;
  /** Highest classification this caller may read, before the Confidential grant check. */
  clearance: number;
  canManageConnectors: boolean;
  canViewAudit: boolean;
  /** Scopes this caller holds an unexpired Confidential grant for. */
  confidentialScopes: Set<string>;
  scopeAccess: ScopeAccess;
  /** Scopes this caller is the Lead of. Empty for everyone else. */
  ownedScopes: Set<string>;
};

/**
 * Everything the access rule needs about one caller, in one round trip's worth
 * of queries.
 *
 * `scopes` is the caller's resolved permission scopes from
 * resolvePermissionScopes - workspace ids plus their own email. It is passed
 * in rather than resolved here because the team digest deliberately resolves
 * it differently (personal sources excluded), and that decision belongs to the
 * caller of this function.
 */
export async function loadCallerAuthz(
  tenantId: string,
  userId: string,
  email: string | null,
): Promise<CallerAuthz> {
  const [membership, grants, owned, scopeAccess] = await Promise.all([
    // withAdmin, not withTenant, and this is load-bearing. public.memberships
    // has RLS enabled AND forced with exactly one policy, scoped to the
    // `authenticated` role - there is no policy for the locus_app lane at all,
    // so a withTenant read of this table returns zero rows for everyone,
    // always. getCurrentTenant already reads it through withAdmin for the same
    // reason.
    //
    // Getting this wrong took the whole product down for a day: no row meant
    // role level 0, clearance 0 hides everything at Internal, and Internal is
    // the default every record carries. Every dashboard in production read
    // zero decisions. The tenant and user are both pinned in the WHERE clause,
    // which is the Layer-2 scoping this codebase uses wherever the admin
    // connection is unavoidable.
    withAdmin(async (sql) => {
      const rows = await sql`
        select role, role_level, can_manage_connectors, can_view_audit, expires_at
        from public.memberships
        where tenant_id = ${tenantId}::uuid and user_id = ${userId}::uuid
      `;
      return rows[0] ?? null;
    }),
    withTenant(tenantId, async (sql) => {
      return await sql`
        select scope_id from public.confidential_grants
        where tenant_id = ${tenantId}::uuid and user_id = ${userId}::uuid
          and (expires_at is null or expires_at > now())
      `;
    }),
    withTenant(tenantId, async (sql) => {
      return await sql`
        select scope_id from public.scope_owners
        where tenant_id = ${tenantId}::uuid and user_id = ${userId}::uuid
      `;
    }),
    loadScopeAccess(tenantId, email),
  ]);

  // No membership row means the caller is not in this tenant at all, and every
  // caller reaches this only after getCurrentTenant has already asserted
  // membership - so it cannot legitimately happen, and when it did happen it
  // was a broken query rather than a removed member.
  //
  // Which is why it now THROWS instead of quietly degrading to clearance 0.
  // Silently returning "you may see nothing" is indistinguishable from an empty
  // workspace: the dashboard renders zeroes, nothing is logged, and the product
  // looks like it lost the data rather than like it has a bug. A 500 with this
  // message is worse for one request and enormously better for everyone.
  const row = membership as
    | {
      role: string;
      role_level: number;
      can_manage_connectors: boolean;
      can_view_audit: boolean;
      expires_at: string | null;
    }
    | null;


  if (!row) {
    throw new Error(
      `No membership for user ${userId} in tenant ${tenantId} - refusing to ` +
      `resolve an access level. This is a bug, not an empty workspace: every ` +
      `caller here has already passed getCurrentTenant.`,
    );
  }

  // An expired Guest IS an expected path, and unlike the case above it degrades
  // rather than throws: their membership is real, it has simply run out, and
  // "sees nothing above Public" is the defined behaviour rather than a fault.
  const expired = row.expires_at ? new Date(row.expires_at).getTime() <= Date.now() : false;
  const roleLevel = expired ? 0 : Number(row.role_level ?? 2);

  return {
    userId,
    tenantId,
    email,
    role: row.role,
    roleLevel,
    clearance: clearanceForLevel(roleLevel),
    canManageConnectors: row.can_manage_connectors === true,
    canViewAudit: row.can_view_audit === true,
    confidentialScopes: new Set(
      (grants as unknown as { scope_id: string }[]).map((g) => g.scope_id),
    ),
    ownedScopes: new Set(
      (owned as unknown as { scope_id: string }[]).map((o) => o.scope_id),
    ),
    scopeAccess,
  };
}

/**
 * A caller who can see nothing above Public and belongs to no scope.
 *
 * Used for the shared team digest, which is built once per tenant and handed
 * to everyone, so it has to be built under the clearance of its least
 * privileged recipient rather than that of whoever happened to open it first.
 */
export function floorAuthz(base: CallerAuthz): CallerAuthz {
  return { ...base, roleLevel: 1, clearance: 0, confidentialScopes: new Set() };
}

// ── The rule ─────────────────────────────────────────────────────────────

export type ClassifiedRecord = {
  permission_scope?: string[] | null;
  classification?: number | null;
};

/** Condition (2). */
export function scopeAllows(
  record: ClassifiedRecord,
  callerScopes: string[],
  access: ScopeAccess,
): boolean {
  const scopes = record.permission_scope ?? [];
  if (scopes.length === 0) return true;
  // Workspace-level scopes and the caller's own email, unchanged.
  if (scopes.some((s) => callerScopes.includes(s))) return true;
  // Real membership: the caller is in one of the channels this came from.
  if (scopes.some((s) => access.memberOf.has(s))) return true;
  // We hold real membership data for at least one of these scopes and the
  // caller is in none of them. This is the case that used to fail open.
  if (scopes.some((s) => access.known.has(s))) return false;
  // No membership data for any scope yet: unchanged legacy behaviour.
  return scopes.every(isUnmappedScope);
}

/**
 * Condition (3).
 *
 * Levels 0 to 2 are the ordered clearance test. Level 3 is not, and the
 * distinction resolves a contradiction in the design this implements: its
 * clearance table gives a Lead clearance 2, while its worked example says the
 * Lead who owns a scope reads a Confidential record "only with grant". Under a
 * strict ordering those cannot both hold - a Lead at clearance 2 could never
 * reach level 3, and the grant would do nothing for the one role the example
 * uses it on.
 *
 * Resolved in favour of the example, because it is the more concrete
 * statement and because it is the arrangement that actually means something:
 * at Confidential the COMPARTMENT is the authority, not the rank. That is the
 * operational form of the distinction the whole design is about - being
 * permitted to access something is not the same as needing to know it - and a
 * junior person can legitimately need to know exactly one confidential thing
 * without being promoted to learn it.
 *
 * So: an Admin without a grant is refused, and a Member with one is admitted.
 * Every other cell of the document's table is unchanged by this reading,
 * because the roles it shows as refused hold no grant.
 *
 * Guests are the one hard floor. "Read-only, public records in explicitly
 * granted scopes, time-limited" is the entire role; admitting a contractor to
 * acquisition discussions because somebody clicked the wrong row is not a
 * mistake worth leaving available.
 */
export function clearanceAllows(record: ClassifiedRecord, authz: CallerAuthz): boolean {
  const level = record.classification ?? 1;

  if (level >= CONFIDENTIAL) {
    if (authz.roleLevel < MIN_LEVEL_FOR_CONFIDENTIAL) return false;
    // Per scope, never tenant-wide. A record carrying no scope at all can
    // therefore never be granted, which fails closed - correctly.
    const scopes = record.permission_scope ?? [];
    return scopes.some((s) => authz.confidentialScopes.has(s));
  }

  return level <= authz.clearance;
}

/** Conditions (2) and (3) together. */
export function isRecordVisible(
  record: ClassifiedRecord,
  callerScopes: string[],
  authz: CallerAuthz,
): boolean {
  return scopeAllows(record, callerScopes, authz.scopeAccess) && clearanceAllows(record, authz);
}

export function filterVisibleRecords<T extends ClassifiedRecord>(
  records: T[],
  callerScopes: string[],
  authz: CallerAuthz,
): T[] {
  return records.filter((r) => isRecordVisible(r, callerScopes, authz));
}

/**
 * All four conditions, for a caller who holds only record ids.
 *
 * MCP is the caller this exists for. Its tools go through the FTS RPC or a
 * direct table read as the service role, so the rows come back with no scope
 * or classification attached and there is nothing to filter in place. It is
 * also the surface most likely to be forgotten and the most exposed: an
 * external agent holding an MCP token is not a person looking at a screen, and
 * until now tenant id plus the personal-source rule was the entire check it
 * ran. Scope has never been enforced there at all.
 *
 * Resolving to a specific user and inheriting that user's clearance - rather
 * than granting a service-level view - is the whole point. An agent must never
 * see more than the person who connected it.
 */
export async function visibleIdsUnderFullRule(
  tenantId: string,
  userId: string,
  recordIds: string[],
): Promise<Set<string>> {
  if (recordIds.length === 0) return new Set();

  const { scopes, email } = await resolvePermissionScopes(userId, tenantId);
  const [authz, personallyVisible, rows] = await Promise.all([
    loadCallerAuthz(tenantId, userId, email),
    // Condition (4), unchanged - it is a join against source_connections
    // rather than a property of the record, so it stays where it already is.
    visibleRecordIds(tenantId, userId, recordIds),
    withTenant(tenantId, async (sql) => {
      return await sql`
        select id, permission_scope, classification
        from public.decisions
        where tenant_id = ${tenantId}::uuid and id = any(${recordIds}::uuid[])
      `;
    }),
  ]);

  const visible = new Set<string>();
  for (
    const row of rows as unknown as {
      id: string;
      permission_scope: string[] | null;
      classification: number | null;
    }[]
  ) {
    if (!personallyVisible.has(row.id)) continue;
    if (
      !isRecordVisible(
        { permission_scope: row.permission_scope ?? [], classification: row.classification },
        scopes,
        authz,
      )
    ) continue;
    visible.add(row.id);
  }
  return visible;
}
