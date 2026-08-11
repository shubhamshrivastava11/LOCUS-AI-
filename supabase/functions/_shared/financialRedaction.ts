// supabase/functions/_shared/financialRedaction.ts
//
// Deterministic (regex-based, not AI-judgment-based) scrubbing of financial
// identifiers. Applied to every connector's raw_content in queue.ts before
// the event is enqueued, and again to extraction output in ai-worker before
// it's persisted to decisions - so a card/account/routing number can never
// reach raw_events or a permanent decision record intact, regardless of
// whether the triage LLM correctly classifies the surrounding message.
//
// This is a defense-in-depth heuristic, not a perfect PII detector: it is
// intentionally biased toward over-redacting (e.g. a long order/tracking
// number) rather than under-redacting, since the cost of losing an
// incidental long number is far lower than the cost of leaking a real
// financial identifier.

const CARD_NUMBER_RE = /\b(?:\d[ -]?){13,19}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// Catch-all: any standalone run of 9+ digits (routing numbers, bank account
// numbers, card numbers that failed the Luhn check due to a typo/OCR error,
// etc.) not already redacted above.
const LONG_DIGIT_RUN_RE = /\b\d{9,}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactFinancialInfo(input: string): string {
  if (!input) return input;
  let out = input;

  out = out.replace(CARD_NUMBER_RE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits)
      ? "[REDACTED-CARD]"
      : match;
  });

  out = out.replace(IBAN_RE, "[REDACTED-IBAN]");
  out = out.replace(SSN_RE, "[REDACTED-SSN]");
  out = out.replace(LONG_DIGIT_RUN_RE, "[REDACTED-NUMBER]");

  return out;
}

// Recursively redacts every string value in a JSON-like structure (objects,
// arrays, nested combinations) - raw_content shapes differ per connector
// (Gmail: flat string fields, Notion: a full nested page object), so this
// has to walk arbitrary structure rather than assume flat fields.
export function redactFinancialInfoDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactFinancialInfo(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactFinancialInfoDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactFinancialInfoDeep(v);
    }
    return out as T;
  }
  return value;
}
