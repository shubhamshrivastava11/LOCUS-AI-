/**
 * The standard enterprise department set, and the corridors between them.
 *
 * Grounded in APQC's Process Classification Framework, Cross-Industry v7.4
 * (c) 2024 APQC - the open cross-industry taxonomy of business processes,
 * thirteen top-level Categories split into Operating Processes (1.0 to 6.0)
 * and Management and Support Services (7.0 to 13.0). Each department below
 * records the PCF category it derives from, so the taxonomy can be defended
 * rather than asserted.
 *
 * We deliberately split some PCF categories that companies staff separately.
 * PCF 3.0 is "Market and Sell Products and Services" as one category; almost
 * no company runs Marketing and Sales as one department, and a routing rule
 * that cannot tell them apart is useless. The same applies to Product and
 * Engineering inside 2.0, and Support and Customer Success inside 6.0.
 * Splitting is safe in a way that merging is not: two departments can always
 * be pointed at each other with a corridor, whereas one department covering
 * two teams cannot be told apart by any rule.
 *
 * DEFAULT CLASSIFICATIONS are floors, never ceilings. Every one of them can
 * only raise a record above the global default of 1 (Internal). Nothing here
 * can make anything more visible than it would otherwise have been.
 */

import type { RoutingRule } from "./rules.ts";

export type DepartmentTemplate = {
  /** Stable key. Used to wire corridors before real uuids exist. */
  key: string;
  name: string;
  /** Which APQC PCF v7.4 category this derives from. */
  pcf: string;
  /** Revenue spine, build spine, delivery, or a control function. */
  group: "executive" | "build" | "revenue" | "delivery" | "control";
  /** Floor for records captured in this department. */
  defaultClassification: 0 | 1 | 2 | 3;
  why: string;
};

export const DEPARTMENTS: DepartmentTemplate[] = [
  {
    key: "executive",
    name: "Executive",
    pcf: "1.0 Develop Vision and Strategy",
    group: "executive",
    defaultClassification: 2,
    why: "Strategy and budget allocation before they are announced. Restricted " +
      "by default because an unannounced priority shift is market-sensitive " +
      "and routinely leaks through exactly this kind of tool.",
  },
  {
    key: "product",
    name: "Product",
    pcf: "2.0 Develop and Manage Products and Services",
    group: "build",
    defaultClassification: 1,
    why: "What ships, what got cut and why. Ordinary internal work.",
  },
  {
    key: "engineering",
    name: "Engineering",
    pcf: "2.0 Develop and Manage Products and Services",
    group: "build",
    defaultClassification: 1,
    why: "Technical constraints and what is actually possible. Split from " +
      "Product because they are staffed separately and a rule needs to " +
      "address one without the other.",
  },
  {
    key: "analytics",
    name: "Data and Analytics",
    pcf: "13.0 Develop and Manage Business Capabilities",
    group: "build",
    defaultClassification: 1,
    why: "Whether the last decision worked. The measurement half of the loop.",
  },
  {
    key: "marketing",
    name: "Marketing",
    pcf: "3.0 Market and Sell Products and Services",
    group: "revenue",
    defaultClassification: 1,
    why: "Positioning and what was promised publicly.",
  },
  {
    key: "sales",
    name: "Sales",
    pcf: "3.0 Market and Sell Products and Services",
    group: "revenue",
    defaultClassification: 1,
    why: "What was committed to a customer. Split from Marketing: PCF groups " +
      "them, companies do not.",
  },
  {
    key: "customer_success",
    name: "Customer Success",
    pcf: "6.0 Manage Customer Service",
    group: "revenue",
    defaultClassification: 1,
    why: "Which accounts are at risk and why.",
  },
  {
    key: "support",
    name: "Support",
    pcf: "6.0 Manage Customer Service",
    group: "revenue",
    defaultClassification: 1,
    why: "What is breaking, at what volume. The earliest signal a product " +
      "decision was wrong.",
  },
  {
    key: "supply_chain",
    name: "Supply Chain and Operations",
    pcf: "4.0 Manage Supply Chain for Physical Products",
    group: "delivery",
    defaultClassification: 1,
    why: "Sourcing, vendors and fulfilment. Empty at a software company, " +
      "which is fine: an unused department costs nothing and its absence " +
      "would be a gap the moment a customer has physical goods.",
  },
  {
    key: "delivery",
    name: "Delivery and Professional Services",
    pcf: "5.0 Deliver Services",
    group: "delivery",
    defaultClassification: 1,
    why: "Implementation and services actually delivered to a customer.",
  },
  {
    key: "hr",
    name: "People and HR",
    pcf: "7.0 Develop and Manage Human Capital",
    group: "control",
    defaultClassification: 2,
    why: "Headcount, org changes, performance. Restricted by default and " +
      "raised to Confidential by rule the moment compensation appears.",
  },
  {
    key: "it_security",
    name: "IT and Security",
    pcf: "8.0 Manage Information Technology (IT)",
    group: "control",
    defaultClassification: 2,
    why: "Access, incidents and vendor approvals. An open incident is " +
      "exactly what an attacker most wants to read.",
  },
  {
    key: "finance",
    name: "Finance",
    pcf: "9.0 Manage Financial Resources",
    group: "control",
    defaultClassification: 2,
    why: "Budget, spend approvals and what got funded.",
  },
  {
    key: "facilities",
    name: "Facilities and Assets",
    pcf: "10.0 Acquire, Construct, and Manage Assets",
    group: "control",
    defaultClassification: 1,
    why: "Property, equipment and the physical estate.",
  },
  {
    key: "legal",
    name: "Legal, Risk and Compliance",
    pcf: "11.0 Manage Enterprise Risk, Compliance, Remediation, and Resiliency",
    group: "control",
    defaultClassification: 2,
    why: "What the company is contractually bound to, and what it may claim. " +
      "Also where privilege lives, which is its own reason for a floor.",
  },
  {
    key: "external",
    name: "External Relations",
    pcf: "12.0 Manage External Relationships",
    group: "control",
    defaultClassification: 1,
    why: "Press, investors, regulators and partners.",
  },
];

// ---------------------------------------------------------------------------
// Corridors
// ---------------------------------------------------------------------------

/** A routing rule before the departments have real uuids. */
export type CorridorTemplate =
  & Omit<RoutingRule, "id" | "from_department_id" | "to_department_id">
  & { from: string; to: string };

/**
 * The corridors that carry real decision traffic.
 *
 * Not all 240 ordered pairs matter. These are the ones that exist in most
 * companies, and the allowlists are the point: what crosses is always a
 * named subset, never the record.
 *
 * Read the emit_classification column down and the shape of the product is
 * visible. Corridors out of a control function emit LOWER than their source,
 * because the whole job is letting a narrower fact reach a wider audience
 * without carrying what made it narrow.
 */
export const CORRIDORS: CorridorTemplate[] = [
  // --- the control functions, where the redaction actually matters --------
  {
    name: "Accepted offer to Finance",
    from: "hr",
    to: "finance",
    when_record_type: "decision",
    when_min_classification: 3,
    when_has_fields: ["annualised_cost", "role_title"],
    emit_classification: 2,
    carry_fields: ["role_title", "band", "start_date", "annualised_cost"],
    purpose: "headcount cost forecasting",
  },
  {
    name: "Org change to affected managers",
    from: "hr",
    to: "executive",
    when_record_type: "decision",
    when_min_classification: 2,
    when_has_fields: ["team", "headcount_delta"],
    emit_classification: 2,
    carry_fields: ["team", "effective_date", "headcount_delta"],
    purpose: "org planning and reporting lines",
  },
  {
    name: "Approved requisition to HR",
    from: "finance",
    to: "hr",
    when_record_type: "decision",
    when_min_classification: 2,
    when_has_fields: ["approved_amount", "role_title"],
    emit_classification: 2,
    carry_fields: ["role_title", "cost_centre", "approved_amount", "period"],
    purpose: "opening a requisition only once the budget for it exists",
  },
  {
    name: "Approved budget to Engineering",
    from: "finance",
    to: "engineering",
    when_record_type: "decision",
    when_min_classification: 2,
    when_has_fields: ["approved_amount", "cost_centre"],
    emit_classification: 1,
    carry_fields: ["cost_centre", "approved_amount", "period", "decision_statement"],
    purpose: "letting a team plan against a budget it was granted",
  },
  {
    name: "Infrastructure spend to Finance",
    from: "engineering",
    to: "finance",
    when_record_type: "decision",
    when_min_classification: 1,
    // Without this the corridor fires on every Engineering decision, because
    // "decision" is the generic record type and decision_statement is always
    // present. The cost figure is what makes it a spend decision.
    when_has_fields: ["estimated_monthly_cost"],
    emit_classification: 2,
    carry_fields: ["decision_statement", "cost_driver", "estimated_monthly_cost"],
    purpose: "cloud cost attribution",
  },
  {
    name: "Contract constraint to Sales",
    from: "legal",
    to: "sales",
    when_record_type: "decision",
    when_min_classification: 2,
    when_has_fields: [],
    emit_classification: 2,
    carry_fields: ["constraint", "applies_to", "effective_date"],
    purpose: "preventing a commitment the contract forbids",
  },
  {
    name: "Claim restriction to Marketing",
    from: "legal",
    to: "marketing",
    when_record_type: "decision",
    when_min_classification: 2,
    when_has_fields: [],
    emit_classification: 2,
    carry_fields: ["constraint", "applies_to"],
    purpose: "preventing a public claim the company cannot support",
  },
  {
    name: "Security incident to Engineering",
    from: "it_security",
    to: "engineering",
    when_record_type: "blocker",
    when_min_classification: 2,
    when_has_fields: [],
    emit_classification: 2,
    carry_fields: ["severity", "affected_component", "required_action", "due_date"],
    purpose: "remediation by the team that owns the component",
  },

  // --- the revenue spine, mostly ordinary ---------------------------------
  {
    name: "Customer commitment to Product",
    from: "sales",
    to: "product",
    when_record_type: "decision",
    when_min_classification: 1,
    when_has_fields: ["committed_date"],
    emit_classification: 1,
    carry_fields: ["decision_statement", "account_segment", "committed_date"],
    purpose: "making the roadmap aware of what was promised to close a deal",
  },
  {
    name: "Customer commitment to Engineering",
    from: "sales",
    to: "engineering",
    when_record_type: "decision",
    when_min_classification: 1,
    when_has_fields: ["committed_date"],
    emit_classification: 1,
    carry_fields: ["decision_statement", "committed_date"],
    purpose: "feasibility review of a commitment already made",
  },
  {
    name: "Failure pattern to Product",
    from: "support",
    to: "product",
    when_record_type: "blocker",
    when_min_classification: 0,
    // A pattern has to name what is failing. Without this the corridor
    // emits for every Support blocker carrying nothing but the statement,
    // which gives Product a duplicate with less information than the
    // original rather than a signal.
    when_has_fields: ["affected_component"],
    emit_classification: 1,
    carry_fields: ["decision_statement", "affected_component", "volume", "severity"],
    purpose: "prioritising by what is actually breaking for customers",
  },
  {
    name: "Failure pattern to Engineering",
    from: "support",
    to: "engineering",
    when_record_type: "blocker",
    when_min_classification: 0,
    when_has_fields: [],
    emit_classification: 1,
    carry_fields: ["affected_component", "volume", "severity"],
    purpose: "triage by the team that owns the component",
  },
  {
    name: "Account risk to Customer Success",
    from: "support",
    to: "customer_success",
    when_record_type: "blocker",
    when_min_classification: 0,
    when_has_fields: [],
    emit_classification: 1,
    carry_fields: ["account_segment", "severity", "volume"],
    purpose: "renewal risk from unresolved support load",
  },
  {
    name: "Churn reason to Product",
    from: "customer_success",
    to: "product",
    when_record_type: "decision",
    when_min_classification: 1,
    when_has_fields: ["reason_code"],
    emit_classification: 1,
    carry_fields: ["decision_statement", "account_segment", "reason_code"],
    purpose: "roadmap input from why accounts actually leave",
  },

  // --- the build spine, and the loop back ---------------------------------
  {
    name: "Ship decision to Marketing",
    from: "product",
    to: "marketing",
    when_record_type: "decision",
    when_min_classification: 0,
    when_has_fields: ["ship_date"],
    emit_classification: 1,
    carry_fields: ["decision_statement", "ship_date", "user_facing"],
    purpose: "launch planning for what is actually shipping",
  },
  {
    name: "Ship decision to Sales",
    from: "product",
    to: "sales",
    when_record_type: "decision",
    when_min_classification: 0,
    when_has_fields: ["ship_date"],
    emit_classification: 1,
    carry_fields: ["decision_statement", "ship_date"],
    purpose: "letting Sales speak accurately about what exists",
  },
  {
    name: "Shipped feature to Analytics",
    from: "engineering",
    to: "analytics",
    when_record_type: "decision",
    when_min_classification: 0,
    when_has_fields: ["acceptance_criteria"],
    emit_classification: 1,
    carry_fields: ["decision_statement", "acceptance_criteria", "ship_date"],
    purpose: "measuring whether a shipped change did what it intended",
  },
  {
    name: "Measured outcome to Product",
    from: "analytics",
    to: "product",
    when_record_type: "decision",
    when_min_classification: 0,
    when_has_fields: ["metric"],
    emit_classification: 1,
    carry_fields: ["decision_statement", "metric", "direction", "measured_at"],
    purpose: "closing the loop between a decision and its effect",
  },
  {
    name: "Measured outcome to Executive",
    from: "analytics",
    to: "executive",
    when_record_type: "decision",
    when_min_classification: 0,
    when_has_fields: ["metric"],
    emit_classification: 1,
    carry_fields: ["metric", "direction", "measured_at"],
    purpose: "strategy review against measured outcomes",
  },
];

// ---------------------------------------------------------------------------
// Classification rules
// ---------------------------------------------------------------------------

/** A classification rule before the departments have real uuids. */
export type ClassificationRuleTemplate = {
  name: string;
  /** Department key, or null for tenant-wide. */
  department: string | null;
  match_type: "always" | "contains_any";
  match_terms: string[];
  set_classification: 0 | 1 | 2 | 3;
  set_compartment: string | null;
  priority: number;
};

/**
 * The rules that raise a record above its department default.
 *
 * Kept few and specific. Every one of these can only RAISE, so the cost of a
 * false positive is a record that is harder to reach than it needed to be,
 * and the cost of a false negative is a record more visible than it should
 * be. That asymmetry is why the terms are narrow words that rarely appear by
 * accident rather than broad ones that catch everything.
 *
 * The HR compensation rule is the one the worked example turns on: it is
 * what makes an accepted offer Confidential at source, so that the corridor
 * to Finance is redacting something rather than forwarding an already-open
 * record.
 */
export const CLASSIFICATION_RULES: ClassificationRuleTemplate[] = [
  {
    name: "Compensation is confidential",
    department: "hr",
    match_type: "contains_any",
    // Deliberately not "pay" or "band" on their own: "pay attention" and
    // "band 3 latency" are ordinary sentences, and a rule that fires on them
    // buries real work behind a compartment nobody has.
    match_terms: [
      "salary", "compensation", "annualised cost", "annualized cost",
      "equity grant", "bonus", "severance", "offer letter",
    ],
    set_classification: 3,
    // At Confidential the compartment is the authority rather than the rank,
    // so this names one. Without it the record would be unreadable by
    // everyone including the person who wrote it.
    set_compartment: "hiring",
    priority: 10,
  },
  {
    name: "Performance and conduct are confidential",
    department: "hr",
    match_type: "contains_any",
    match_terms: [
      "performance improvement", "disciplinary", "grievance",
      "termination", "dismissal", "misconduct",
    ],
    set_classification: 3,
    set_compartment: "people-cases",
    priority: 10,
  },
  {
    name: "Legal privilege is confidential",
    department: "legal",
    match_type: "contains_any",
    match_terms: [
      "privileged", "attorney-client", "litigation", "settlement",
      "acquisition", "due diligence",
    ],
    set_classification: 3,
    set_compartment: "legal-privileged",
    priority: 10,
  },
  {
    name: "Open security incidents are restricted",
    department: "it_security",
    match_type: "contains_any",
    match_terms: [
      "vulnerability", "breach", "exploit", "credential leak",
      "unauthorised access", "unauthorized access",
    ],
    set_classification: 2,
    set_compartment: null,
    priority: 20,
  },
];

/** Departments keyed for lookup, so a corridor can be validated against them. */
export const DEPARTMENT_KEYS = new Set(DEPARTMENTS.map((d) => d.key));
