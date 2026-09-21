/**
 * Rules engine behaviour, including the worked HR-to-Finance case end to end.
 *
 * The two properties worth protecting, both asserted directly rather than
 * left to follow from the code reading correctly:
 *
 *   a rule can only RAISE classification, never lower it
 *   a field not on the allowlist never crosses a department boundary
 */
import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import {
  applyAllowlist,
  type ClassificationRule,
  planRouting,
  resolveClassification,
  type RoutableRecord,
  type RoutingRule,
} from "./rules.ts";

const HR = "dept-hr";
const FIN = "dept-finance";

const baseInput = {
  text: "we agreed to move the launch to November",
  departmentId: null as string | null,
  proposedLevel: 1,
  scopeFloor: 0,
  departmentDefault: 0,
};

const rule = (over: Partial<ClassificationRule> = {}): ClassificationRule => ({
  id: "r1",
  name: "rule one",
  department_id: null,
  match_type: "always",
  match_terms: [],
  set_classification: 2,
  set_compartment: null,
  priority: 100,
  ...over,
});

// ---------------------------------------------------------------------------
// Classification: the raise-only invariant
// ---------------------------------------------------------------------------

Deno.test("classification: with no rules the model's proposal stands", () => {
  const out = resolveClassification([], { ...baseInput, proposedLevel: 2 });
  assertEquals(out.classification, 2);
  assertEquals(out.decidedBy, "model");
});

Deno.test("classification: a rule can raise the level", () => {
  const out = resolveClassification([rule({ set_classification: 2 })], baseInput);
  assertEquals(out.classification, 2);
  assertEquals(out.decidedBy, "rule");
  assertEquals(out.matchedRuleName, "rule one");
});

Deno.test("classification: a rule can NEVER lower the level", () => {
  // The invariant. A rule saying "Public" against a record the model called
  // Confidential must not declassify it - otherwise adding configuration
  // could expose existing records, which is the one thing configuration must
  // never be able to do.
  for (let proposed = 0; proposed <= 3; proposed++) {
    for (let ruleLevel = 0; ruleLevel <= 3; ruleLevel++) {
      const out = resolveClassification(
        [rule({ set_classification: ruleLevel, set_compartment: ruleLevel === 3 ? "c" : null })],
        { ...baseInput, proposedLevel: proposed },
      );
      if (out.classification < proposed) {
        throw new Error(
          `rule at ${ruleLevel} lowered a record from ${proposed} to ${out.classification}`,
        );
      }
    }
  }
});

Deno.test("classification: rule ORDER cannot change the resulting level", () => {
  // max() over all matches rather than first-match-wins, so reordering a list
  // in a future admin UI cannot quietly declassify anything.
  const a = rule({ id: "a", name: "a", set_classification: 1, priority: 1 });
  const b = rule({ id: "b", name: "b", set_classification: 3, set_compartment: "hiring", priority: 2 });
  const forward = resolveClassification([a, b], baseInput).classification;
  const reversed = resolveClassification([b, a], baseInput).classification;
  assertEquals(forward, 3);
  assertEquals(reversed, 3);
});

Deno.test("classification: the highest of every source wins", () => {
  const out = resolveClassification([rule({ set_classification: 1 })], {
    ...baseInput,
    proposedLevel: 0,
    scopeFloor: 2,
    departmentDefault: 1,
  });
  assertEquals(out.classification, 2);
  assertEquals(out.decidedBy, "scope_floor");
});

Deno.test("classification: contains_any matches case-insensitively, and only on real terms", () => {
  const comp = rule({ match_type: "contains_any", match_terms: ["Salary"], set_classification: 2 });
  assertEquals(
    resolveClassification([comp], { ...baseInput, text: "her SALARY is agreed" }).classification,
    2,
  );
  assertEquals(
    resolveClassification([comp], { ...baseInput, text: "the launch is agreed" }).classification,
    1,
  );
  // A blank term inside the array must not become a match-everything rule.
  const blank = rule({ match_type: "contains_any", match_terms: ["  "], set_classification: 3, set_compartment: "x" });
  assertEquals(resolveClassification([blank], baseInput).classification, 1);
});

Deno.test("classification: a department-scoped rule ignores other departments", () => {
  const hrOnly = rule({ department_id: HR, set_classification: 3, set_compartment: "hiring" });
  assertEquals(
    resolveClassification([hrOnly], { ...baseInput, departmentId: HR }).classification,
    3,
  );
  assertEquals(
    resolveClassification([hrOnly], { ...baseInput, departmentId: FIN }).classification,
    1,
  );
  assertEquals(resolveClassification([hrOnly], baseInput).classification, 1);
});

Deno.test("classification: the compartment comes from the rule that set the level", () => {
  const low = rule({ id: "low", set_classification: 1, set_compartment: "wrong", priority: 1 });
  const high = rule({ id: "high", set_classification: 3, set_compartment: "hiring", priority: 2 });
  const out = resolveClassification([low, high], baseInput);
  assertEquals(out.classification, 3);
  assertEquals(out.compartment, "hiring", "must not inherit a compartment from a rule that lost");
});

// ---------------------------------------------------------------------------
// Routing: the allowlist invariant
// ---------------------------------------------------------------------------

const offer: RoutableRecord = {
  id: "dec-1",
  record_type: "offer_accepted",
  classification: 3,
  departmentId: HR,
  fields: {
    role_title: "Senior Engineer",
    band: 3,
    start_date: "2026-11-03",
    annualised_cost: 145000,
    candidate_name: "A. Person",
    negotiation_notes: "asked for 10% more, settled at band 3",
    band_rationale: "prior title and years",
  },
};

const toFinance: RoutingRule = {
  id: "rr-1",
  name: "offer accepted to finance",
  from_department_id: HR,
  to_department_id: FIN,
  when_record_type: "offer_accepted",
  when_min_classification: 3,
  emit_classification: 2,
  carry_fields: ["role_title", "band", "start_date", "annualised_cost"],
  purpose: "headcount cost forecasting",
};

Deno.test("routing: the worked HR to Finance case", () => {
  const plans = planRouting([toFinance], offer);
  assertEquals(plans.length, 1);

  const p = plans[0];
  assertEquals(p.toDepartmentId, FIN);
  assertEquals(p.classification, 2, "Restricted in the destination, not Confidential");
  assertEquals(p.purpose, "headcount cost forecasting");
  assertEquals(Object.keys(p.fields).sort(), [
    "annualised_cost",
    "band",
    "role_title",
    "start_date",
  ]);
  assertEquals(p.withheldFields, ["band_rationale", "candidate_name", "negotiation_notes"]);
  assertEquals(p.sourceDecisionId, "dec-1");
});

Deno.test("routing: a field absent from the allowlist NEVER crosses", () => {
  // The invariant, asserted against every field the source carries rather
  // than against the three we happened to think of.
  const plans = planRouting([toFinance], offer);
  const carried = Object.keys(plans[0].fields);
  for (const name of Object.keys(offer.fields)) {
    const permitted = toFinance.carry_fields.includes(name);
    assertEquals(
      carried.includes(name),
      permitted,
      `${name} should ${permitted ? "" : "not "}have crossed`,
    );
  }
});

Deno.test("routing: a new field on the source is withheld by default", () => {
  // The reason this is an allowlist. Adding a column must not silently start
  // leaking it to every department a rule already points at.
  const withNewField: RoutableRecord = {
    ...offer,
    fields: { ...offer.fields, home_address: "somewhere private" },
  };
  const p = planRouting([toFinance], withNewField)[0];
  assertEquals("home_address" in p.fields, false);
  assertEquals(p.withheldFields.includes("home_address"), true);
});

Deno.test("routing: a derived record is never MORE sensitive than its source", () => {
  const raising: RoutingRule = { ...toFinance, emit_classification: 3, when_min_classification: 0 };
  for (let sourceLevel = 0; sourceLevel <= 3; sourceLevel++) {
    const p = planRouting([raising], { ...offer, classification: sourceLevel })[0];
    if (p.classification > sourceLevel) {
      throw new Error(`emitted ${p.classification} from a source at ${sourceLevel}`);
    }
  }
});

Deno.test("routing: conditions are ANDed", () => {
  assertEquals(planRouting([toFinance], { ...offer, record_type: "decision" }).length, 0);
  assertEquals(planRouting([toFinance], { ...offer, classification: 2 }).length, 0);
  assertEquals(planRouting([toFinance], { ...offer, departmentId: FIN }).length, 0);
  assertEquals(planRouting([toFinance], { ...offer, departmentId: null }).length, 0);
});

Deno.test("routing: a rule carrying nothing emits nothing", () => {
  const empty: RoutingRule = { ...toFinance, carry_fields: ["field_that_does_not_exist"] };
  assertEquals(planRouting([empty], offer).length, 0);
});

Deno.test("routing: a derived record is never routed onward", () => {
  // One hop, always. Without this, two departments with corridors pointing
  // at each other on the same record type would bounce a record between
  // them forever - and Product/Sales is exactly such a pair in the standard
  // set, both legitimate, both carrying "decision".
  const derived: RoutableRecord = { ...offer, isDerived: true };
  assertEquals(planRouting([toFinance], derived).length, 0);
  // And the same record without the flag still routes, so the guard is the
  // thing doing the work rather than some other condition.
  assertEquals(planRouting([toFinance], { ...offer, isDerived: false }).length, 1);
});

Deno.test("routing: the source record is never mutated", () => {
  const before = JSON.stringify(offer);
  planRouting([toFinance], offer);
  assertEquals(JSON.stringify(offer), before);
});

Deno.test("routing: withheld names are recorded but values never are", () => {
  const p = planRouting([toFinance], offer)[0];
  const serialised = JSON.stringify(p);
  assertEquals(serialised.includes("A. Person"), false, "a withheld value leaked into the plan");
  assertEquals(serialised.includes("settled at band 3"), false);
  assertEquals(p.withheldFields.includes("candidate_name"), true);
});

Deno.test("routing: allowlist is exact, not prefix or case insensitive", () => {
  const record: RoutableRecord = {
    ...offer,
    fields: { band: 3, Band: "capital", band_rationale: "no", bandwidth: "no" },
  };
  const { fields } = applyAllowlist(record, ["band"]);
  assertEquals(Object.keys(fields), ["band"]);
});
