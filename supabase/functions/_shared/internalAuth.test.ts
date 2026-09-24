// Tests for the operator credential check.
//
// This file exists because internalAuth is the only thing standing in front of
// endpoints that decrypt raw_events across every tenant and spend the model
// budget. The 14 Sep review found those endpoints with no check at all, and
// the fix is now load-bearing enough that "it typechecks" is not evidence.
//
// The multi-key change is what prompted these: splitting a secret on commas is
// the kind of edit that looks trivial and has two failure modes that both fail
// OPEN. A value of only separators could leave an empty key list that matches
// anything, and an empty string entry could match a caller who sends no key.
// Both are tested below.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { requireInternalKey } from "./internalAuth.ts";

const KEY_A = "operator-alice-9f3c2b7a41d8";
const KEY_B = "operator-bob-77e1aa04cc52";

function reqWith(header: string | null, value?: string): Request {
  const headers = new Headers();
  if (header && value !== undefined) headers.set(header, value);
  return new Request("https://example.test/admin-replay?source=gmail", { headers });
}

/** Runs fn with INTERNAL_FUNCTION_KEY set to `value`, then restores it. */
async function withSecret(value: string | null, fn: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get("INTERNAL_FUNCTION_KEY");
  if (value === null) Deno.env.delete("INTERNAL_FUNCTION_KEY");
  else Deno.env.set("INTERNAL_FUNCTION_KEY", value);
  try {
    await fn();
  } finally {
    if (previous === undefined) Deno.env.delete("INTERNAL_FUNCTION_KEY");
    else Deno.env.set("INTERNAL_FUNCTION_KEY", previous);
  }
}

/** null means "allowed through"; otherwise the rejection's status. */
async function status(secret: string | null, header: string | null, value?: string) {
  let result: number | null = null;
  await withSecret(secret, async () => {
    const res = await requireInternalKey(reqWith(header, value));
    result = res === null ? null : res.status;
  });
  return result;
}

Deno.test("a single configured key still works, via x-internal-key", async () => {
  assertEquals(await status(KEY_A, "x-internal-key", KEY_A), null);
});

Deno.test("a single configured key still works, via Authorization Bearer", async () => {
  assertEquals(await status(KEY_A, "Authorization", `Bearer ${KEY_A}`), null);
});

Deno.test("with two keys configured, each one is accepted on its own", async () => {
  const secret = `${KEY_A},${KEY_B}`;
  assertEquals(await status(secret, "x-internal-key", KEY_A), null);
  assertEquals(await status(secret, "x-internal-key", KEY_B), null);
});

Deno.test("revoking one key leaves the other working and locks the first out", async () => {
  // The entire point of the change: Lam's key can be deleted without
  // rotating the value every cron job depends on.
  assertEquals(await status(KEY_A, "x-internal-key", KEY_B), 401);
  assertEquals(await status(KEY_A, "x-internal-key", KEY_A), null);
});

Deno.test("whitespace around a key is tolerated, since humans edit this by hand", async () => {
  assertEquals(await status(`  ${KEY_A} ,  ${KEY_B}  `, "x-internal-key", KEY_B), null);
});

Deno.test("a trailing comma does not create a key that matches nothing-sent", async () => {
  // An empty entry left in the list would compare equal to a caller who sends
  // an empty x-internal-key header, which is an auth bypass.
  assertEquals(await status(`${KEY_A},`, "x-internal-key", KEY_A), null);
  assertEquals(await status(`${KEY_A},`, "x-internal-key", ""), 401);
});

Deno.test("a key that is not configured is rejected", async () => {
  assertEquals(await status(`${KEY_A},${KEY_B}`, "x-internal-key", "not-a-key"), 401);
});

Deno.test("no credential at all is rejected", async () => {
  assertEquals(await status(`${KEY_A},${KEY_B}`, null), 401);
});

Deno.test("an unset secret fails closed with 503, never open", async () => {
  assertEquals(await status(null, "x-internal-key", KEY_A), 503);
});

Deno.test("a secret of only separators fails closed, it does not admit everyone", async () => {
  // The dangerous shape: split(",") on ",," yields empty strings only, so a
  // naive implementation ends up with no keys and an any-match loop.
  assertEquals(await status(",,", "x-internal-key", KEY_A), 503);
  assertEquals(await status(" , ", "x-internal-key", ""), 503);
});

Deno.test("the platform key in Authorization does not defeat x-internal-key", async () => {
  // x-internal-key is checked first precisely so a caller can satisfy the
  // Supabase gateway and this check at the same time. If Authorization won,
  // every gateway-routed call would be rejected - the bug documented in
  // internalAuth.ts.
  const headers = new Headers();
  headers.set("Authorization", "Bearer some-supabase-anon-key");
  headers.set("x-internal-key", KEY_A);
  let code: number | null = null;
  await withSecret(KEY_A, async () => {
    const res = await requireInternalKey(new Request("https://example.test/x", { headers }));
    code = res === null ? null : res.status;
  });
  assertEquals(code, null);
});

Deno.test("a rejection body reveals nothing about the endpoint or the key", async () => {
  await withSecret(KEY_A, async () => {
    const res = await requireInternalKey(reqWith("x-internal-key", "wrong"));
    const body = await res!.json();
    assertEquals(body, { error: "Unauthorized" });
  });
});
