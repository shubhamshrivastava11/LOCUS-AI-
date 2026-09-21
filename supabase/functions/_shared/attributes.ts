/**
 * The attribute keys a record may carry, and the sanitiser that enforces it.
 *
 * The extraction tool lets the model return a free-form object rather than
 * declaring twenty-six optional properties in the schema, which would add
 * several hundred tokens to every call to describe fields that are null on
 * almost every record. The cost of that freedom is that the model can return
 * anything, so the keys are whitelisted here before anything is stored.
 *
 * The model proposes, the server decides - the same posture already taken
 * with the sensitivity field, where an out-of-range value falls back to the
 * default rather than being trusted.
 *
 * Every key below exists because a routing corridor names it. Adding a key
 * nothing routes on would be storing data with no reader, so the test
 * asserts the two lists agree.
 */

/** What an attribute value may be once sanitised. */
export type AttributeValue = string | number | boolean;

export const ALLOWED_ATTRIBUTES = [
  // people and hiring
  "role_title",
  "band",
  "start_date",
  "annualised_cost",
  "team",
  "headcount_delta",
  "effective_date",

  // money
  "cost_centre",
  "approved_amount",
  "period",
  "cost_driver",
  "estimated_monthly_cost",

  // legal
  "constraint",
  "applies_to",

  // incidents and failures
  "severity",
  "affected_component",
  "required_action",
  "due_date",
  "volume",

  // commercial
  "account_segment",
  "committed_date",
  "reason_code",

  // shipping and measurement
  "ship_date",
  "user_facing",
  "acceptance_criteria",
  "metric",
  "direction",
  "measured_at",
] as const;

const ALLOWED = new Set<string>(ALLOWED_ATTRIBUTES);

/** Longest value we will store for a single attribute. */
const MAX_LENGTH = 500;

/**
 * Keeps the recognised keys and drops everything else.
 *
 * Rejects rather than coerces. A cost arriving as the string "about 145k" is
 * not a number, and storing it as one would invent precision the source did
 * not have; storing it as a string would make a corridor that compares costs
 * silently wrong. Dropping it means the corridor does not fire, which is the
 * correct outcome for a fact we do not actually have.
 */
export function sanitiseAttributes(raw: unknown): Record<string, AttributeValue> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED.has(key)) continue;

    if (typeof value === "string") {
      const trimmed = value.trim();
      // An empty string is the model saying "not present". Stored, it would
      // satisfy a when_has_fields check and fire a corridor on nothing -
      // which is why routingRuleApplies also rejects "", belt and braces.
      if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) continue;
      out[key] = trimmed;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
    // null, undefined, objects and arrays are all dropped.
  }
  return out;
}
