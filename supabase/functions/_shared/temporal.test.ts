import { filterTemporal, isCurrent, isValidAt, parseAsOf } from "./temporal.ts";
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SEP01 = "2026-09-01T00:00:00Z";
const SEP05 = "2026-09-05T00:00:00Z";
const SEP10 = "2026-09-10T00:00:00Z";

const current = { valid_from: SEP01, valid_until: null };
const superseded = { valid_from: SEP01, valid_until: SEP05 };

// ── parseAsOf ───────────────────────────────────────────────────────────

Deno.test("parseAsOf returns null when absent, meaning the live view", () => {
  assertEquals(parseAsOf(null), null);
  assertEquals(parseAsOf(undefined), null);
  assertEquals(parseAsOf(""), null);
});

Deno.test("parseAsOf accepts a bare date and a full timestamp", () => {
  assertEquals(parseAsOf("2026-09-01")?.toISOString(), "2026-09-01T00:00:00.000Z");
  assertEquals(parseAsOf(SEP05)?.toISOString(), "2026-09-05T00:00:00.000Z");
});

Deno.test("parseAsOf throws rather than silently answering as of now", () => {
  // The whole point: a bad as_of must not quietly return today's data,
  // because the caller cannot tell the difference.
  assertThrows(() => parseAsOf("last tuesday"), RangeError);
  assertThrows(() => parseAsOf("2026-13-45"), RangeError);
  assertThrows(() => parseAsOf("not-a-date"), RangeError);
});

// ── isCurrent ───────────────────────────────────────────────────────────

Deno.test("isCurrent is true only while valid_until is unset", () => {
  assertEquals(isCurrent(current), true);
  assertEquals(isCurrent(superseded), false);
});

// ── isValidAt ───────────────────────────────────────────────────────────

Deno.test("a superseded memory was true before it was superseded", () => {
  assertEquals(isValidAt(superseded, new Date(SEP01)), true);
  assertEquals(isValidAt(superseded, new Date("2026-09-04T23:59:59Z")), true);
});

Deno.test("a superseded memory is not true after it was superseded", () => {
  assertEquals(isValidAt(superseded, new Date(SEP10)), false);
});

Deno.test("a memory is not true before it existed", () => {
  assertEquals(isValidAt(current, new Date("2026-08-01T00:00:00Z")), false);
});

Deno.test("valid_from is inclusive and valid_until exclusive at the changeover instant", () => {
  // The replacement takes over at exactly the moment the old one ends, so
  // exactly one of the pair is true at that instant - never both, never
  // neither. This is what stops a point-in-time query double-counting.
  const replacement = { valid_from: SEP05, valid_until: null };
  const at = new Date(SEP05);
  assertEquals(isValidAt(superseded, at), false);
  assertEquals(isValidAt(replacement, at), true);
});

Deno.test("a missing valid_from means always-has-been, not never-was", () => {
  // A row from an older code path must not vanish from every historical
  // answer just because it predates the temporal columns.
  const legacy = { valid_from: null, valid_until: null };
  assertEquals(isValidAt(legacy, new Date("2020-01-01T00:00:00Z")), true);
  assertEquals(isCurrent(legacy), true);
});

Deno.test("an unparseable timestamp is ignored rather than hiding the row", () => {
  const broken = { valid_from: "garbage", valid_until: "garbage" };
  assertEquals(isValidAt(broken, new Date(SEP05)), true);
});

// ── filterTemporal ──────────────────────────────────────────────────────

Deno.test("filterTemporal with no instant returns only current memories", () => {
  assertEquals(filterTemporal([current, superseded], null), [current]);
});

Deno.test("filterTemporal reconstructs the past, including memories since replaced", () => {
  const at = new Date("2026-09-03T00:00:00Z");
  assertEquals(filterTemporal([current, superseded], at).length, 2);
});

Deno.test("filterTemporal at a point before anything existed returns nothing", () => {
  assertEquals(filterTemporal([current, superseded], new Date("2020-01-01T00:00:00Z")), []);
});

Deno.test("Date and string timestamps behave identically", () => {
  const asDates = { valid_from: new Date(SEP01), valid_until: new Date(SEP05) };
  const at = new Date("2026-09-03T00:00:00Z");
  assertEquals(isValidAt(asDates, at), isValidAt(superseded, at));
  assertEquals(isCurrent(asDates), isCurrent(superseded));
});
