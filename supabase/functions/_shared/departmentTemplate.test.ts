/**
 * Validates the standard department set and its corridors.
 *
 * These are data, not code, which is exactly why they need tests: a typo in
 * a department key or a missing field in an allowlist is invisible on
 * reading and produces a corridor that silently never fires, or worse, one
 * that carries a field nobody intended.
 *
 * The properties asserted here are the ones the database CHECK constraints
 * cannot express, plus the ones that only make sense across the whole set.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/testing/asserts.ts";
import {
  CORRIDORS,
  DEPARTMENT_KEYS,
  DEPARTMENTS,
} from "./departmentTemplate.ts";
import { planRouting, type RoutableRecord, type RoutingRule } from "./rules.ts";

// ---------------------------------------------------------------------------
// The department set
// ---------------------------------------------------------------------------

Deno.test("departments: keys are unique", () => {
  assertEquals(DEPARTMENT_KEYS.size, DEPARTMENTS.length);
});

Deno.test("departments: names are unique", () => {
  // The table has unique(tenant_id, name), so a duplicate here would fail on
  // insert halfway through seeding and leave a tenant half-configured.
  const names = new Set(DEPARTMENTS.map((d) => d.name));
  assertEquals(names.size, DEPARTMENTS.length);
});

Deno.test("departments: every one cites a PCF category and a reason", () => {
  for (const d of DEPARTMENTS) {
    assertEquals(/^\d{1,2}\.0 /.test(d.pcf), true, `${d.key} has no PCF category`);
    assertEquals(d.why.length > 30, true, `${d.key} has no real justification`);
  }
});

Deno.test("departments: PCF categories are all within 1.0 to 13.0", () => {
  for (const d of DEPARTMENTS) {
    const n = parseInt(d.pcf.split(".")[0], 10);
    assertEquals(n >= 1 && n <= 13, true, `${d.key} cites ${d.pcf}, outside the framework`);
  }
});

Deno.test("departments: every control function has a floor above Internal", () => {
  // The control functions are where the sensitive material lives. One of
  // them defaulting to Internal is the configuration mistake that matters.
  for (const d of DEPARTMENTS.filter((x) => x.group === "control")) {
    if (d.key === "facilities" || d.key === "external") continue; // deliberately ordinary
    assertEquals(
      d.defaultClassification >= 2,
      true,
      `${d.name} is a control function defaulting to ${d.defaultClassification}`,
    );
  }
});

Deno.test("departments: no default is Confidential", () => {
  // A department-wide default of 3 would make every record in it require a
  // compartment grant, which means nobody reads anything by default. If that
  // is ever wanted it should be a deliberate rule, not a department default.
  for (const d of DEPARTMENTS) {
    assertEquals(d.defaultClassification < 3, true, `${d.name} defaults to Confidential`);
  }
});

// ---------------------------------------------------------------------------
// The corridors
// ---------------------------------------------------------------------------

Deno.test("corridors: both endpoints are real departments", () => {
  for (const c of CORRIDORS) {
    assertEquals(DEPARTMENT_KEYS.has(c.from), true, `${c.name}: unknown from "${c.from}"`);
    assertEquals(DEPARTMENT_KEYS.has(c.to), true, `${c.name}: unknown to "${c.to}"`);
  }
});

Deno.test("corridors: no corridor points at its own department", () => {
  for (const c of CORRIDORS) {
    assertEquals(c.from === c.to, false, `${c.name} routes ${c.from} to itself`);
  }
});

Deno.test("corridors: names are unique", () => {
  const names = new Set(CORRIDORS.map((c) => c.name));
  assertEquals(names.size, CORRIDORS.length);
});

Deno.test("corridors: every allowlist is non-empty and has no duplicates", () => {
  for (const c of CORRIDORS) {
    assertEquals(c.carry_fields.length > 0, true, `${c.name} carries nothing`);
    assertEquals(
      new Set(c.carry_fields).size,
      c.carry_fields.length,
      `${c.name} lists a field twice`,
    );
  }
});

Deno.test("corridors: no allowlist carries an identifying field", () => {
  // The whole point of the HR corridors. A field name that looks like a
  // person, an address or a raw note must not appear in any allowlist, in
  // any corridor, not merely the ones we were thinking about.
  const FORBIDDEN = [
    "candidate_name", "employee_name", "name", "email", "phone",
    "home_address", "address", "salary", "compensation", "ssn",
    "national_id", "date_of_birth", "dob", "negotiation_notes",
    "performance_notes", "medical",
  ];
  for (const c of CORRIDORS) {
    for (const f of c.carry_fields) {
      assertEquals(
        FORBIDDEN.includes(f),
        false,
        `${c.name} carries "${f}", which identifies or exposes a person`,
      );
    }
  }
});

Deno.test("corridors: every purpose is stated and specific", () => {
  // The DB constraint only checks length >= 8. This checks it is a sentence
  // about why, not a restatement of the rule name.
  for (const c of CORRIDORS) {
    assertEquals(c.purpose.trim().length >= 15, true, `${c.name}: purpose too thin`);
    assertEquals(
      c.purpose.toLowerCase() === c.name.toLowerCase(),
      false,
      `${c.name}: purpose merely repeats the name`,
    );
  }
});

Deno.test("corridors: a corridor out of a control function never raises sensitivity", () => {
  // Routing exists to let a narrower fact reach a wider audience. A corridor
  // leaving HR, Finance, Legal or Security at a HIGHER level than the source
  // department's own floor would be manufacturing secrecy on the way out.
  const floorOf = new Map(DEPARTMENTS.map((d) => [d.key, d.defaultClassification]));
  for (const c of CORRIDORS) {
    const from = DEPARTMENTS.find((d) => d.key === c.from)!;
    if (from.group !== "control") continue;
    assertEquals(
      c.emit_classification <= Math.max(floorOf.get(c.from)!, c.when_min_classification ?? 0),
      true,
      `${c.name} emits ${c.emit_classification} out of a department floored at ${
        floorOf.get(c.from)
      }`,
    );
  }
});

Deno.test("corridors: the HR to Finance corridor withholds everything identifying", () => {
  // The worked case, checked against a realistic source record rather than
  // against the allowlist we wrote.
  const corridor = CORRIDORS.find((c) => c.name === "Accepted offer to Finance")!;
  const rule: RoutingRule = {
    ...corridor,
    id: "rr",
    from_department_id: "hr",
    to_department_id: "finance",
  };
  const record: RoutableRecord = {
    id: "d1",
    record_type: "offer_accepted",
    classification: 3,
    departmentId: "hr",
    fields: {
      role_title: "Senior Engineer",
      band: 3,
      start_date: "2026-11-03",
      annualised_cost: 145000,
      candidate_name: "A. Person",
      negotiation_notes: "settled at band 3",
      home_address: "private",
    },
  };
  const [plan] = planRouting([rule], record);
  assertEquals(plan.classification, 2);
  assertEquals(Object.keys(plan.fields).sort(), [
    "annualised_cost", "band", "role_title", "start_date",
  ]);
  assertEquals(plan.withheldFields, ["candidate_name", "home_address", "negotiation_notes"]);
  assertEquals(JSON.stringify(plan).includes("A. Person"), false);
});

Deno.test("corridors: opposite pairs exist, and the one-hop guard is what makes them safe", () => {
  // Writing this test found a real hazard. Sales to Product and Product to
  // Sales are both legitimate, both carry record_type "decision", and each
  // emits at or above the other's threshold - so if derived records were
  // ever routed onward, a ship decision sent to Sales would come straight
  // back as a Sales decision, forever.
  //
  // Contorting the data to avoid it would have been the wrong fix: it would
  // push the same trap onto whoever writes the next pair. planRouting
  // refuses to route a derived record at all, which ends it for every pair
  // including ones nobody has written yet. This asserts both halves: that
  // such pairs really are present, and that the guard really does stop them.
  const hazardous: string[] = [];
  for (const a of CORRIDORS) {
    for (const b of CORRIDORS) {
      if (a.from !== b.to || a.to !== b.from) continue;
      if (a.when_record_type !== b.when_record_type) continue;
      if (
        a.emit_classification >= (b.when_min_classification ?? 0) &&
        b.emit_classification >= (a.when_min_classification ?? 0)
      ) {
        hazardous.push(`${a.name} <-> ${b.name}`);
      }
    }
  }
  assertEquals(
    hazardous.length > 0,
    true,
    "expected at least one opposite pair; if none remain, this test is no longer proving anything",
  );

  // The guard, exercised directly against one of the pairs found above.
  const rule: RoutingRule = {
    ...CORRIDORS[0],
    id: "rr",
    from_department_id: "a",
    to_department_id: "b",
    when_record_type: null,
    when_min_classification: 0,
    when_has_fields: [],
  };
  const derived: RoutableRecord = {
    id: "d",
    record_type: "decision",
    classification: 2,
    departmentId: "a",
    fields: { role_title: "x" },
    isDerived: true,
  };
  assertEquals(planRouting([rule], derived).length, 0, "a derived record must not route onward");
  assertEquals(planRouting([rule], { ...derived, isDerived: false }).length, 1);
});

Deno.test("corridors: a generic-type corridor must narrow itself somehow", () => {
  // The bug this was written for. "Infrastructure spend to Finance" matched
  // record_type "decision" - the generic type - and carried
  // decision_statement, which every record has, so it emitted to Finance for
  // every Engineering decision ever captured. Nothing was internally
  // inconsistent; every CHECK constraint passed. The only way to see it was
  // to ask what the corridor would match in practice.
  //
  // So: a corridor on the generic type has to narrow itself by something
  // other than the record type, or it is a firehose.
  const GENERIC = new Set(["decision", null]);
  for (const c of CORRIDORS) {
    if (!GENERIC.has(c.when_record_type)) continue;
    const narrowed = (c.when_has_fields?.length ?? 0) > 0 ||
      (c.when_min_classification ?? 0) >= 2;
    assertEquals(
      narrowed,
      true,
      `"${c.name}" fires on the generic record type with nothing to narrow it: ` +
        `it will emit for every record leaving ${c.from}`,
    );
  }
});

Deno.test("corridors: when_has_fields names are a subset of what can cross", () => {
  // Requiring a field the corridor then withholds is legal but almost
  // always a mistake: it means the destination gets a record triggered by
  // something it cannot see. Allowed only where clearly deliberate.
  for (const c of CORRIDORS) {
    for (const f of c.when_has_fields ?? []) {
      assertEquals(
        c.carry_fields.includes(f),
        true,
        `"${c.name}" requires ${f} but does not carry it`,
      );
    }
  }
});

Deno.test("corridors: which are actually REACHABLE with today's extraction", () => {
  // The gap this exists to make visible.
  //
  // ai-worker passes routing exactly five fields, and the extractor can only
  // produce three record types. Measured against that, no corridor in the
  // standard set can emit anything: the ones keyed to offer_accepted or
  // budget_approval can never match a record type that does not exist, and
  // the rest carry allowlists that share no field with what is available,
  // so applyAllowlist returns empty and planRouting skips them.
  //
  // Routing is therefore wired, correct, and dormant. That is a reasonable
  // state to be in - inert is much better than wrong - but it is invisible
  // from the outside, and "we shipped routing" would be a misleading thing
  // to say about it. This test states the position and will FAIL the moment
  // extraction gets richer, which is exactly when somebody needs to know
  // that corridors just became live.
  const EXTRACTED_FIELDS = [
    "decision_statement", "rationale", "alternatives_considered", "status", "record_type",
  ];
  const EXTRACTED_TYPES = ["decision", "action_item", "blocker"];

  const reachable = CORRIDORS.filter((c) => {
    if (c.when_record_type !== null && !EXTRACTED_TYPES.includes(c.when_record_type)) return false;
    // Every required field must be producible.
    if ((c.when_has_fields ?? []).some((f) => !EXTRACTED_FIELDS.includes(f))) return false;
    // And at least one carried field must exist, or nothing is emitted.
    return c.carry_fields.some((f) => EXTRACTED_FIELDS.includes(f));
  }).map((c) => c.name);

  assertEquals(
    reachable,
    [],
    "a corridor just became reachable. Routing is now live for it - confirm the " +
      "allowlist is right, and update the canary baselines, because derived " +
      "records will change the per-role counts.",
  );
});

Deno.test("corridors: every department that produces traffic can also receive it", () => {
  // Not a hard requirement, but a department that only ever emits is a
  // reporting line rather than a participant, and is usually a sign the
  // reverse corridor was forgotten. Reported rather than enforced.
  const emits = new Set(CORRIDORS.map((c) => c.from));
  const receives = new Set(CORRIDORS.map((c) => c.to));
  const emitOnly = [...emits].filter((k) => !receives.has(k)).sort();
  assertEquals(
    emitOnly,
    ["it_security", "legal", "support"],
    "the set of emit-only departments changed; confirm the new one is deliberate",
  );
});
