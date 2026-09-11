// supabase/functions/_shared/temporal.ts
//
// The temporal memory model's rules, as pure functions.
//
// Extracted rather than inlined so they can be tested without a database,
// and so "what does current mean" has exactly one definition. Before this,
// the answer was hardcoded as `superseded_by IS NULL` in some queries and
// simply absent in others - which is how search ended up able to cite a
// superseded decision as though it were still true.
//
// The model (see migration 20260909100000):
//
//   valid_from   when a memory became true
//   valid_until  when it stopped being true; null means still true
//
// Two questions the system asks:
//
//   current            valid_until IS NULL
//   true at time T     valid_from <= T AND (valid_until IS NULL OR valid_until > T)
//
// Note the asymmetry in the bounds: valid_from is inclusive and valid_until
// exclusive. A memory superseded at 14:00 was true at 13:59:59 and is not
// true at 14:00, and its replacement - whose valid_from is exactly 14:00 -
// is. Any other choice makes both or neither true at the changeover
// instant, and a point-in-time query would double-count or lose a memory.

/** A record carrying temporal validity. Only the two fields are required. */
export interface TemporallyValid {
  valid_from?: string | Date | null;
  valid_until?: string | Date | null;
}

function toTime(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Parses an as_of query parameter.
 *
 * Returns null for an absent value (meaning "now", the live view) and
 * throws for an unparseable one. Deliberately not lenient: silently
 * answering a historical question with today's data is a worse failure
 * than an error, because the caller cannot tell it happened.
 */
export function parseAsOf(raw: string | null | undefined): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new RangeError("as_of must be an ISO 8601 date or timestamp");
  }
  return new Date(ms);
}

/** Whether this memory is true right now. */
export function isCurrent(record: TemporallyValid): boolean {
  return toTime(record.valid_until) === null;
}

/**
 * Whether this memory was true at a given instant.
 *
 * A missing valid_from is treated as "always has been" rather than "never
 * was": rows predating the temporal migration were backfilled, but a row
 * arriving from an older code path should stay visible rather than silently
 * vanish from every point-in-time answer.
 */
export function isValidAt(record: TemporallyValid, at: Date): boolean {
  const t = at.getTime();
  const from = toTime(record.valid_from);
  const until = toTime(record.valid_until);
  if (from !== null && from > t) return false;
  if (until !== null && until <= t) return false;
  return true;
}

/**
 * Filters a set of memories to those true at `at`, or to the current ones
 * when `at` is null. The in-memory counterpart of the SQL predicate, for
 * callers that already hold rows.
 */
export function filterTemporal<T extends TemporallyValid>(
  records: T[],
  at: Date | null,
): T[] {
  return at === null
    ? records.filter(isCurrent)
    : records.filter((r) => isValidAt(r, at));
}
