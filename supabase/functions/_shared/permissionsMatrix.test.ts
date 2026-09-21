/**
 * Exhaustive access matrix: every role, every classification, in and out of
 * scope, with and without a compartment grant.
 *
 * permissions.test.ts already covers the interesting individual cases. This
 * file exists for a different reason: to make sure no CELL of the matrix is
 * untested. A rule with five roles and four classifications has forty
 * combinations once scope and grant are folded in, and the 16 September
 * outage was a combination nobody had written a case for.
 *
 * The expected values below are written out BY HAND from the stated rule,
 * not generated. That is the whole point. A matrix computed with
 * clearanceForLevel would agree with the implementation no matter what the
 * implementation did, including when it is wrong - which is exactly the trap
 * the recorded visibility baselines already sit in, since those were derived
 * from observed behaviour rather than from the specification.
 *
 * If a cell here disagrees with the code, one of the two is wrong and the
 * disagreement is the finding. Do not "fix" the table to match the code
 * without deciding which one states the intent.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import {
  type CallerAuthz,
  clearanceAllows,
  clearanceForLevel,
  isRecordVisible,
} from "./permissions.ts";

const ENG = "C_ENGINEERING";
const HR = "C_HR";

type RoleName = "Owner" | "Admin" | "Lead" | "Member" | "External";

/** The hierarchy as the migration defines it, spelled out rather than imported. */
const ROLES: Array<{ name: RoleName; level: number; clearance: number }> = [
  { name: "Owner", level: 5, clearance: 3 },
  { name: "Admin", level: 4, clearance: 3 },
  { name: "Lead", level: 3, clearance: 2 },
  { name: "Member", level: 2, clearance: 1 },
  { name: "External", level: 1, clearance: 0 },
];

function caller(
  level: number,
  options: { memberOf?: string[]; known?: string[]; grant?: string[]; expired?: boolean } = {},
): CallerAuthz {
  const effective = options.expired ? 0 : level;
  return {
    userId: "u1",
    tenantId: "t1",
    email: "me@acme.com",
    role: "matrix",
    roleLevel: effective,
    clearance: clearanceForLevel(effective),
    canManageConnectors: false,
    canViewAudit: false,
    confidentialScopes: new Set(options.grant ?? []),
    ownedScopes: new Set(),
    scopeAccess: {
      known: new Set(options.known ?? options.memberOf ?? []),
      memberOf: new Set(options.memberOf ?? []),
    },
  } as CallerAuthz;
}

const record = (classification: number, scope = ENG) => ({
  classification,
  permission_scope: [scope],
});

// ---------------------------------------------------------------------------
// 1. Clearance is what the hierarchy says it is.
// ---------------------------------------------------------------------------

Deno.test("matrix: each role maps to the clearance the hierarchy states", () => {
  for (const { name, level, clearance } of ROLES) {
    assertEquals(
      clearanceForLevel(level),
      clearance,
      `${name} (level ${level}) should have clearance ${clearance}`,
    );
  }
});

Deno.test("matrix: an unrecognised level never invents clearance", () => {
  // 0 is an expired seat. 6 and up would be a role added to the enum without
  // anyone updating clearanceForLevel - it must not silently inherit the top
  // clearance by falling through a >= comparison.
  assertEquals(clearanceForLevel(0), 0, "level 0 reads Public only");
  assertEquals(clearanceForLevel(-1), 0, "a negative level fails closed");
  assertEquals(clearanceForLevel(6), 3, "level 6 is capped at Confidential, not beyond");
});

// ---------------------------------------------------------------------------
// 2. The full matrix, in scope, no grant.
// ---------------------------------------------------------------------------

/** Written from the rule. Index is the classification: 0, 1, 2, 3. */
const IN_SCOPE_NO_GRANT: Record<RoleName, boolean[]> = {
  //         Public  Internal  Restricted  Confidential
  Owner: [true, true, true, false],
  Admin: [true, true, true, false],
  Lead: [true, true, true, false],
  Member: [true, true, false, false],
  External: [true, false, false, false],
};

Deno.test("matrix: in scope, no grant, every role against every classification", () => {
  for (const { name, level } of ROLES) {
    const authz = caller(level, { memberOf: [ENG], known: [ENG] });
    for (let cls = 0; cls <= 3; cls++) {
      assertEquals(
        isRecordVisible(record(cls), [], authz),
        IN_SCOPE_NO_GRANT[name][cls],
        `${name} + classification ${cls}, in scope, no grant`,
      );
    }
  }
});

Deno.test("matrix: nobody reads Confidential on rank alone", () => {
  // The single most important row above. Owner and Admin hold clearance 3 and
  // are still refused, because at Confidential the compartment is the
  // authority rather than the rank.
  for (const { name, level } of ROLES) {
    const authz = caller(level, { memberOf: [ENG], known: [ENG] });
    assertEquals(
      clearanceAllows(record(3), authz),
      false,
      `${name} must not reach Confidential without a grant`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. The same matrix with a compartment grant on that scope.
// ---------------------------------------------------------------------------

/**
 * A grant changes exactly one column. Restricted is unaffected, which is the
 * non-obvious part: a Member with a Confidential grant reads the Confidential
 * record and still cannot read a Restricted one, because the grant is a
 * compartment and not a promotion.
 */
const IN_SCOPE_WITH_GRANT: Record<RoleName, boolean[]> = {
  //         Public  Internal  Restricted  Confidential
  Owner: [true, true, true, true],
  Admin: [true, true, true, true],
  Lead: [true, true, true, true],
  Member: [true, true, false, true],
  External: [true, false, false, false],
};

Deno.test("matrix: in scope, with a grant on that scope", () => {
  for (const { name, level } of ROLES) {
    const authz = caller(level, { memberOf: [ENG], known: [ENG], grant: [ENG] });
    for (let cls = 0; cls <= 3; cls++) {
      assertEquals(
        isRecordVisible(record(cls), [], authz),
        IN_SCOPE_WITH_GRANT[name][cls],
        `${name} + classification ${cls}, in scope, granted`,
      );
    }
  }
});

Deno.test("matrix: a grant on a DIFFERENT scope grants nothing here", () => {
  // Grants are per scope, never tenant-wide. An Owner granted the HR
  // compartment reads nothing extra in Engineering.
  for (const { name, level } of ROLES) {
    const authz = caller(level, { memberOf: [ENG], known: [ENG], grant: [HR] });
    assertEquals(
      clearanceAllows(record(3, ENG), authz),
      false,
      `${name} with an HR grant must not read Confidential in Engineering`,
    );
  }
});

Deno.test("matrix: External is the hard floor and a grant does not lift it", () => {
  const granted = caller(1, { memberOf: [ENG], known: [ENG], grant: [ENG] });
  assertEquals(clearanceAllows(record(3), granted), false, "grant must not admit External");
  assertEquals(clearanceAllows(record(2), granted), false, "External reads no Restricted");
  assertEquals(clearanceAllows(record(1), granted), false, "External reads no Internal");
  assertEquals(clearanceAllows(record(0), granted), true, "External reads Public");
});

// ---------------------------------------------------------------------------
// 4. Scope is necessary, for everyone, at every level.
// ---------------------------------------------------------------------------

Deno.test("matrix: out of a known scope, every role sees nothing at any level", () => {
  // This is the property the whole design turns on: seniority buys clearance,
  // never reach. `known` without `memberOf` is the case that used to fail
  // open - we hold membership data for the scope and the caller is not in it.
  for (const { name, level } of ROLES) {
    const authz = caller(level, { known: [ENG], grant: [ENG] });
    for (let cls = 0; cls <= 3; cls++) {
      assertEquals(
        isRecordVisible(record(cls), [], authz),
        false,
        `${name} is not in the scope, so classification ${cls} must be invisible`,
      );
    }
  }
});

Deno.test("matrix: an Owner outside a scope sees less than a Member inside it", () => {
  // Stated as a comparison because it is the sentence people get wrong.
  const ownerOutside = caller(5, { known: [ENG] });
  const memberInside = caller(2, { memberOf: [ENG], known: [ENG] });
  assertEquals(isRecordVisible(record(1), [], ownerOutside), false);
  assertEquals(isRecordVisible(record(1), [], memberInside), true);
});

// ---------------------------------------------------------------------------
// 5. Monotonicity: a more senior role never sees LESS, all else equal.
// ---------------------------------------------------------------------------

Deno.test("matrix: visibility is monotonic in seniority at equal scope and grant", () => {
  // Not a restatement of the table: it catches a future edit that makes some
  // middle role see something its senior cannot, which a per-role assertion
  // would pass individually while the hierarchy as a whole became incoherent.
  for (let cls = 0; cls <= 3; cls++) {
    for (const grant of [[], [ENG]]) {
      // Seeded false, not true: nothing sits below the lowest role, so the
      // first iteration has no predecessor to be worse than. Seeding true
      // makes the bottom role fail against a role that does not exist.
      let previousVisible = false;
      let previousName = "(nothing)";
      for (const { name, level } of [...ROLES].reverse()) { // External up to Owner
        const authz = caller(level, { memberOf: [ENG], known: [ENG], grant });
        const visible = isRecordVisible(record(cls), [], authz);
        if (previousVisible && !visible) {
          throw new Error(
            `${name} sees less than ${previousName} at classification ${cls}` +
              (grant.length ? " with a grant" : "") +
              " - seniority must never remove visibility",
          );
        }
        previousVisible = visible;
        previousName = name;
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 6. Expiry collapses the seat regardless of what it was.
// ---------------------------------------------------------------------------

Deno.test("matrix: an expired seat of any role reads Public only", () => {
  for (const { name, level } of ROLES) {
    const expired = caller(level, { memberOf: [ENG], known: [ENG], grant: [ENG], expired: true });
    assertEquals(expired.clearance, 0, `${name} expired should hold clearance 0`);
    assertEquals(isRecordVisible(record(0), [], expired), true, `${name} expired reads Public`);
    for (let cls = 1; cls <= 3; cls++) {
      assertEquals(
        isRecordVisible(record(cls), [], expired),
        false,
        `${name} expired must not read classification ${cls}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 7. A record with no scope can never be granted.
// ---------------------------------------------------------------------------

Deno.test("matrix: a Confidential record carrying no scope is unreadable by everyone", () => {
  // Fails closed by construction: the grant check looks for the record's
  // scope in the caller's granted set, and an empty scope list matches
  // nothing. Asserted so that a future "convenience" default cannot quietly
  // make an unscoped Confidential record world-readable.
  for (const { name, level } of ROLES) {
    const authz = caller(level, { grant: [ENG, HR] });
    assertEquals(
      clearanceAllows({ classification: 3, permission_scope: [] }, authz),
      false,
      `${name} must not read an unscoped Confidential record`,
    );
  }
});
