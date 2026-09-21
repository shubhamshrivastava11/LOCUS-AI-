// The access rule, tested at the table in the design document.
//
// Everything here is pure: no database, no network. The two halves that do
// touch the database - loadCallerAuthz and loadScopeAccess - are thin queries
// whose output shape is fixed by this file's types, and the interesting
// behaviour is entirely in how those outputs combine.
//
// deno test --node-modules-dir=none --allow-all supabase/functions/_shared/

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CallerAuthz,
  clearanceAllows,
  clearanceForLevel,
  floorAuthz,
  isRecordVisible,
  isUnmappedScope,
  scopeAllows,
  type ScopeAccess,
} from "./permissions.ts";

const NO_SCOPE_DATA: ScopeAccess = { known: new Set(), memberOf: new Set() };

function caller(
  roleLevel: number,
  options: {
    memberOf?: string[];
    known?: string[];
    confidential?: string[];
    expired?: boolean;
  } = {},
): CallerAuthz {
  const level = options.expired ? 0 : roleLevel;
  return {
    userId: "u1",
    tenantId: "t1",
    email: "me@acme.com",
    role: "test",
    roleLevel: level,
    clearance: clearanceForLevel(level),
    canManageConnectors: false,
    canViewAudit: false,
    confidentialScopes: new Set(options.confidential ?? []),
    ownedScopes: new Set(),
    scopeAccess: {
      known: new Set(options.known ?? options.memberOf ?? []),
      memberOf: new Set(options.memberOf ?? []),
    },
  };
}

// Channel ids in the shape source_scope_members stores.
const ENG = "C01ENGINEER";
const SEC = "C02SECURITY";
const HR = "C03HRPRIVAT";

Deno.test("clearance: Owner and Admin read the same sensitivity", () => {
  // Administration is not readership. If Owner outranked Admin here, the top
  // of the hierarchy would be a superuser over content, which is the thing
  // the whole design is arranged to avoid.
  assertEquals(clearanceForLevel(5), 3);
  assertEquals(clearanceForLevel(4), 3);
  assertEquals(clearanceForLevel(3), 2);
  assertEquals(clearanceForLevel(2), 1);
  assertEquals(clearanceForLevel(1), 0);
});

Deno.test("clearance: an unrecognised level reads nothing above Public", () => {
  // Fails closed. A role that does not exist must not inherit Member.
  assertEquals(clearanceForLevel(0), 0);
  assertEquals(clearanceForLevel(99), 3); // deliberately: >= 4 is Owner/Admin
});

Deno.test("scope: an empty permission_scope is visible to the tenant", () => {
  assertEquals(scopeAllows({ permission_scope: [] }, [], NO_SCOPE_DATA), true);
  assertEquals(scopeAllows({}, [], NO_SCOPE_DATA), true);
});

Deno.test("scope: membership in the channel admits", () => {
  const access: ScopeAccess = { known: new Set([ENG]), memberOf: new Set([ENG]) };
  assertEquals(scopeAllows({ permission_scope: [ENG] }, [], access), true);
});

Deno.test("scope: known channel the caller is NOT in denies", () => {
  // The case that used to fail open.
  const access: ScopeAccess = { known: new Set([ENG, HR]), memberOf: new Set([ENG]) };
  assertEquals(scopeAllows({ permission_scope: [HR] }, [], access), false);
});

Deno.test("scope: no membership data anywhere keeps the permissive fallback", () => {
  // Deliberate. Turning enforcement on must not retroactively hide content
  // people were correctly seeing; coverage tightens as the sync fills in.
  assertEquals(scopeAllows({ permission_scope: [HR] }, [], NO_SCOPE_DATA), true);
});

Deno.test("scope: the fallback does not extend to things that are not containers", () => {
  // A Gmail record's scope is the mailbox address. With no membership data an
  // address must still deny, or the fallback becomes a way into somebody
  // else's inbox.
  assertEquals(
    scopeAllows({ permission_scope: ["someone.else@acme.com"] }, ["me@acme.com"], NO_SCOPE_DATA),
    false,
  );
  assertEquals(
    scopeAllows({ permission_scope: ["me@acme.com"] }, ["me@acme.com"], NO_SCOPE_DATA),
    true,
  );
});

Deno.test("scope: ids are recognised in the shapes the connectors emit", () => {
  assertEquals(isUnmappedScope(ENG), true);
  assertEquals(isUnmappedScope("2f1b7c40-8a4e-4c2b-9d31-6f0a1b2c3d4e"), true);
  assertEquals(isUnmappedScope("me@acme.com"), false);
  assertEquals(isUnmappedScope("T01WORKSPACE"), false);
});

Deno.test("clearance: Internal is readable by a Member, Restricted is not", () => {
  const member = caller(2);
  assertEquals(clearanceAllows({ classification: 1 }, member), true);
  assertEquals(clearanceAllows({ classification: 2 }, member), false);
});

Deno.test("clearance: a Lead reads Restricted, and Confidential only with a grant", () => {
  const lead = caller(3);
  assertEquals(clearanceAllows({ classification: 2 }, lead), true);
  assertEquals(clearanceAllows({ classification: 3, permission_scope: [HR] }, lead), false);

  const granted = caller(3, { confidential: [HR] });
  assertEquals(clearanceAllows({ classification: 3, permission_scope: [HR] }, granted), true);
});

Deno.test("clearance: at Confidential the compartment outranks the rank", () => {
  // An Admin without a grant is refused; a Member with one is admitted. This
  // is the reading that makes the grant mean something, and it leaves every
  // cell of the design document's own table unchanged - the roles it shows as
  // refused hold no grant.
  const adminNoGrant = caller(4);
  const memberGranted = caller(2, { confidential: [HR] });
  const record = { classification: 3, permission_scope: [HR] };
  assertEquals(clearanceAllows(record, adminNoGrant), false);
  assertEquals(clearanceAllows(record, memberGranted), true);
});

Deno.test("clearance: an External member is never admitted to Confidential, grant or not", () => {
  const externalGranted = caller(1, { confidential: [HR] });
  assertEquals(clearanceAllows({ classification: 3, permission_scope: [HR] }, externalGranted), false);
});

Deno.test("clearance: Confidential needs a grant even at Admin", () => {
  const admin = caller(4);
  assertEquals(clearanceAllows({ classification: 3, permission_scope: [HR] }, admin), false);

  const granted = caller(4, { confidential: [HR] });
  assertEquals(clearanceAllows({ classification: 3, permission_scope: [HR] }, granted), true);
});

Deno.test("clearance: a grant is per scope, not tenant-wide", () => {
  const granted = caller(4, { confidential: [HR] });
  assertEquals(clearanceAllows({ classification: 3, permission_scope: [SEC] }, granted), false);
});

Deno.test("clearance: a Confidential record with no scope can never be granted", () => {
  // Fails closed rather than falling through the empty-scope shortcut.
  const owner = caller(5, { confidential: [HR] });
  assertEquals(clearanceAllows({ classification: 3, permission_scope: [] }, owner), false);
});

Deno.test("clearance: a missing classification is treated as Internal", () => {
  assertEquals(clearanceAllows({}, caller(2)), true);
  assertEquals(clearanceAllows({ classification: null }, caller(2)), true);
  assertEquals(clearanceAllows({}, caller(1)), false); // External reads Public only
});

// ── The table from the design document ───────────────────────────────────
//
// Four records, five callers. Each cell is the outcome of the WHOLE rule, not
// of the role alone, which is the point the table exists to make.

Deno.test("the four conditions are an AND: an Owner outside the scope sees nothing", () => {
  // R1, routine engineering decision in #eng. The Owner is not in #eng.
  const record = { permission_scope: [ENG], classification: 1 };
  const ownerOutside = caller(5, { memberOf: [], known: [ENG] });
  assertEquals(isRecordVisible(record, [], ownerOutside), false);

  // Same Owner, same record, once they are actually in the channel.
  const ownerInside = caller(5, { memberOf: [ENG], known: [ENG] });
  assertEquals(isRecordVisible(record, [], ownerInside), true);
});

Deno.test("R1 routine, Internal, #eng", () => {
  const r1 = { permission_scope: [ENG], classification: 1 };
  assertEquals(isRecordVisible(r1, [], caller(5, { memberOf: [], known: [ENG] })), false);
  assertEquals(isRecordVisible(r1, [], caller(4, { memberOf: [ENG], known: [ENG] })), true);
  assertEquals(isRecordVisible(r1, [], caller(3, { memberOf: [ENG], known: [ENG] })), true);
  assertEquals(isRecordVisible(r1, [], caller(2, { memberOf: [ENG], known: [ENG] })), true);
  // An External member is in the scope and still refused: clearance 0, record is Internal.
  assertEquals(isRecordVisible(r1, [], caller(1, { memberOf: [ENG], known: [ENG] })), false);
});

Deno.test("R2 security incident, Restricted, #sec", () => {
  const r2 = { permission_scope: [SEC], classification: 2 };
  assertEquals(isRecordVisible(r2, [], caller(5, { memberOf: [], known: [SEC] })), false);
  assertEquals(isRecordVisible(r2, [], caller(4, { memberOf: [SEC], known: [SEC] })), true);
  assertEquals(isRecordVisible(r2, [], caller(3, { memberOf: [SEC], known: [SEC] })), true);
  // The Member is in the channel and still cannot read it. This is the whole
  // vertical dimension in one assertion.
  assertEquals(isRecordVisible(r2, [], caller(2, { memberOf: [SEC], known: [SEC] })), false);
  assertEquals(isRecordVisible(r2, [], caller(1, { memberOf: [SEC], known: [SEC] })), false);
});

Deno.test("R3 performance review, Confidential, #hr-private", () => {
  const r3 = { permission_scope: [HR], classification: 3 };
  // Even the Lead who owns the scope needs an explicit grant, and the Admin
  // is refused despite holding the full administrative surface.
  assertEquals(isRecordVisible(r3, [], caller(4, { memberOf: [HR], known: [HR] })), false);
  assertEquals(isRecordVisible(r3, [], caller(3, { memberOf: [HR], known: [HR] })), false);
  assertEquals(
    isRecordVisible(r3, [], caller(3, { memberOf: [HR], known: [HR], confidential: [HR] })),
    true,
  );
  assertEquals(isRecordVisible(r3, [], caller(2, { memberOf: [HR], known: [HR] })), false);
});

Deno.test("an expired External member reads nothing above Public", () => {
  const record = { permission_scope: [ENG], classification: 1 };
  const external = caller(1, { memberOf: [ENG], known: [ENG], expired: true });
  assertEquals(external.clearance, 0);
  assertEquals(isRecordVisible(record, [], external), false);
});

Deno.test("floorAuthz strips clearance and grants but not scope", () => {
  const admin = caller(4, { memberOf: [ENG], known: [ENG], confidential: [HR] });
  const floored = floorAuthz(admin);

  assertEquals(floored.clearance, 0);
  assertEquals(floored.confidentialScopes.size, 0);
  // Scope membership survives, because the shared digest still must not pull
  // in channels nobody in the tenant belongs to - the floor is about
  // sensitivity, not about widening reach.
  assertEquals(floored.scopeAccess.memberOf.has(ENG), true);

  // An ordinary Internal record drops out of the shared artefact, which is
  // the intended cost of building it once for everybody.
  assertEquals(isRecordVisible({ permission_scope: [ENG], classification: 1 }, [], floored), false);
  assertEquals(isRecordVisible({ permission_scope: [ENG], classification: 0 }, [], floored), true);
});
