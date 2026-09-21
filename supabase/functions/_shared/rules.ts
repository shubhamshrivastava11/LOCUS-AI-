/**
 * The rules engine: classification, then routing.
 *
 * Both halves are pure functions over plain data. The database reads and the
 * inserts live in the caller, so the behaviour that actually matters - what
 * a rule does to a record's sensitivity, and which fields are allowed to
 * cross a department boundary - can be tested exhaustively without a
 * database, a tenant, or a network.
 *
 * Two invariants hold throughout and are asserted in the tests:
 *
 *   1. A classification rule can only ever RAISE a record's level. The
 *      engine returns a floor, and the caller takes max() of it with
 *      everything else, exactly as scope_classification_floors already
 *      works. There is no path by which configuring a rule makes an existing
 *      record more visible than it was.
 *
 *   2. Routing never widens. It creates a NEW record carrying an explicit
 *      allowlist of fields, and the source record is not touched. A field
 *      that is not named does not cross, and the names of the ones withheld
 *      are recorded so an auditor can see what was held back without the
 *      audit itself leaking the values.
 */

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ClassificationRule = {
  id: string;
  name: string;
  department_id: string | null;
  match_type: "always" | "contains_any";
  match_terms: string[];
  set_classification: number;
  set_compartment: string | null;
  priority: number;
};

export type ClassificationInput = {
  /** The record's text, already redacted. Matched case-insensitively. */
  text: string;
  /** The department the record's scope belongs to, if any. */
  departmentId: string | null;
  /** What the model proposed, already clamped to 0-3 by the caller. */
  proposedLevel: number;
  /** The highest scope floor, from scope_classification_floors. */
  scopeFloor: number;
  /** The department's default_classification, if the record has a department. */
  departmentDefault: number;
};

export type ClassificationOutcome = {
  classification: number;
  /** Which input decided the outcome, for the classified_by column. */
  decidedBy: "model" | "default" | "scope_floor" | "department" | "rule";
  compartment: string | null;
  matchedRuleId: string | null;
  matchedRuleName: string | null;
};

function ruleMatches(rule: ClassificationRule, input: ClassificationInput): boolean {
  // A department-scoped rule only applies to records from that department.
  // A rule with no department is tenant-wide.
  if (rule.department_id !== null && rule.department_id !== input.departmentId) return false;

  if (rule.match_type === "always") return true;

  const haystack = input.text.toLowerCase();
  return rule.match_terms.some((term) => {
    const needle = term.trim().toLowerCase();
    // An empty term would match everything. The table constraint forbids an
    // empty array but not a blank string inside one.
    return needle.length > 0 && haystack.includes(needle);
  });
}

/**
 * Resolves a record's classification from every source that can raise it.
 *
 * Deliberately a max() over all sources rather than a first-match-wins
 * cascade. A cascade means the ORDER of rules can lower a record's
 * sensitivity, which is the failure mode where somebody reorders a list in a
 * UI and quietly exposes payroll. Priority only decides which rule gets
 * NAMED as the decider and whose compartment is used; it cannot reduce the
 * level.
 */
export function resolveClassification(
  rules: ClassificationRule[],
  input: ClassificationInput,
): ClassificationOutcome {
  const matched = rules
    .filter((r) => ruleMatches(r, input))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const ruleFloor = matched.reduce((max, r) => Math.max(max, r.set_classification), 0);

  const classification = Math.max(
    input.proposedLevel,
    input.scopeFloor,
    input.departmentDefault,
    ruleFloor,
  );

  // Which source is responsible for the final number. Checked in descending
  // order of specificity so the most informative answer wins a tie: knowing
  // a deliberate rule set this is more useful than knowing the model happened
  // to propose the same value.
  let decidedBy: ClassificationOutcome["decidedBy"];
  if (ruleFloor === classification && matched.length > 0) decidedBy = "rule";
  else if (input.departmentDefault === classification && input.departmentDefault > 0) {
    decidedBy = "department";
  } else if (input.scopeFloor === classification && input.scopeFloor > 0) decidedBy = "scope_floor";
  else if (classification === 1 && input.proposedLevel === 1) decidedBy = "default";
  else decidedBy = "model";

  // The compartment comes from the highest-priority matching rule that both
  // names one AND set the level we landed on. A compartment from a rule that
  // did not decide the level would gate the record on a grant unrelated to
  // why it is sensitive.
  const decidingRule = matched.find(
    (r) => r.set_classification === classification && r.set_compartment !== null,
  ) ?? null;

  return {
    classification,
    decidedBy,
    compartment: decidingRule?.set_compartment ?? null,
    matchedRuleId: decidedBy === "rule" ? (matched[0]?.id ?? null) : null,
    matchedRuleName: decidedBy === "rule" ? (matched[0]?.name ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type RoutingRule = {
  id: string;
  name: string;
  from_department_id: string;
  to_department_id: string;
  when_record_type: string | null;
  when_min_classification: number | null;
  /**
   * Fields the source must actually carry for this rule to fire. Empty means
   * no such requirement.
   *
   * Without this, a corridor aimed at a narrow subject fires on everything.
   * "Infrastructure spend to Finance" is the case that exposed it: it
   * matches record_type "decision", which is the generic type, and its
   * allowlist includes decision_statement, which every record has - so it
   * emitted a Finance record for every Engineering decision ever captured.
   * Requiring estimated_monthly_cost to be present is what makes it a
   * spend corridor rather than a firehose.
   *
   * Distinct from carry_fields on purpose: what a rule needs in order to be
   * RELEVANT is not the same as what it is allowed to CARRY, and conflating
   * them would mean widening a corridor's trigger every time you wanted one
   * more field to cross.
   */
  when_has_fields: string[];
  emit_classification: number;
  carry_fields: string[];
  purpose: string;
};

export type RoutableRecord = {
  id: string;
  record_type: string;
  classification: number;
  departmentId: string | null;
  /** Every field the source record carries, by name. */
  fields: Record<string, unknown>;
  /**
   * True when this record was itself produced by a routing rule, i.e. its
   * source_decision_id is set. Derived records are never routed onward.
   *
   * This is what makes a pair of opposite corridors safe. Product to Sales
   * and Sales to Product are both legitimate and both carry record_type
   * "decision", so without this a ship decision sent to Sales would look
   * like a Sales decision and route straight back, forever. Fixing that by
   * inventing distinct record types per direction would push the problem
   * onto whoever writes the next corridor; refusing to route derived
   * records ends it for every pair, including ones nobody has written yet.
   *
   * The cost is one hop only: a fact can cross one boundary, not two. If a
   * chain is ever genuinely wanted it should be an explicit corridor from
   * the origin, which keeps the audit trail a single edge rather than a
   * path nobody can reconstruct.
   */
  isDerived?: boolean;
};

export type DerivedRecord = {
  rule: RoutingRule;
  toDepartmentId: string;
  classification: number;
  purpose: string;
  /** Only the allowlisted fields, and only those the source actually had. */
  fields: Record<string, unknown>;
  /** Names the allowlist excluded. Names only, never values. */
  withheldFields: string[];
  sourceDecisionId: string;
};

/** Every condition ANDed. No OR, no nesting - see the migration's note. */
export function routingRuleApplies(rule: RoutingRule, record: RoutableRecord): boolean {
  if (record.departmentId === null) return false;
  if (rule.from_department_id !== record.departmentId) return false;
  if (rule.when_record_type !== null && rule.when_record_type !== record.record_type) return false;
  if (
    rule.when_min_classification !== null &&
    record.classification < rule.when_min_classification
  ) {
    return false;
  }
  // Every named field must be present AND carry something. A field set to
  // null or an empty string is the source saying "we do not have this",
  // which should not trigger a corridor that exists because of it.
  for (const field of rule.when_has_fields ?? []) {
    const value = record.fields[field];
    if (value === undefined || value === null || value === "") return false;
  }
  return true;
}

/**
 * Applies the allowlist.
 *
 * `carry_fields` is the complete set of field names permitted to cross. A
 * field absent from the source is simply absent from the result rather than
 * carried as null, because a null in the destination asserts "we know this is
 * empty" when the truth is "this did not come across".
 */
export function applyAllowlist(
  record: RoutableRecord,
  carryFields: string[],
): { fields: Record<string, unknown>; withheldFields: string[] } {
  const allowed = new Set(carryFields);
  const fields: Record<string, unknown> = {};
  const withheldFields: string[] = [];

  for (const [key, value] of Object.entries(record.fields)) {
    if (allowed.has(key)) {
      if (value !== undefined) fields[key] = value;
    } else {
      withheldFields.push(key);
    }
  }
  withheldFields.sort();
  return { fields, withheldFields };
}

/**
 * What a record should emit into other departments, if anything.
 *
 * Returns descriptions rather than performing inserts: the caller writes
 * them, which keeps this function pure and makes the interesting part - what
 * crosses and what does not - testable on its own.
 *
 * A derived record is never emitted at a HIGHER classification than its
 * source. Routing exists to let a narrower fact reach a wider audience; a
 * rule that raised the level on the way out would be creating a secret the
 * source department cannot see, which nothing has asked for and which would
 * make the audit trail lie about where the sensitivity came from.
 */
export function planRouting(
  rules: RoutingRule[],
  record: RoutableRecord,
): DerivedRecord[] {
  // One hop, always. See the note on RoutableRecord.isDerived: this single
  // check is what makes opposite corridors between the same two departments
  // safe, and it holds for corridor pairs nobody has written yet.
  if (record.isDerived) return [];

  const out: DerivedRecord[] = [];

  for (const rule of rules) {
    if (!routingRuleApplies(rule, record)) continue;

    const classification = Math.min(rule.emit_classification, record.classification);
    const { fields, withheldFields } = applyAllowlist(record, rule.carry_fields);

    // A derived record carrying nothing is not a redaction, it is noise in
    // the destination department's feed. Skipped rather than emitted empty.
    if (Object.keys(fields).length === 0) continue;

    out.push({
      rule,
      toDepartmentId: rule.to_department_id,
      classification,
      purpose: rule.purpose,
      fields,
      withheldFields,
      sourceDecisionId: record.id,
    });
  }

  return out;
}
