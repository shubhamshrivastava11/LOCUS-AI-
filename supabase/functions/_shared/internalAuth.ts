// Shared secret check for endpoints that are operational, not user-facing.
//
// Why this exists: the 14 Sep 2026 security review found several functions
// deployed with verify_jwt = false and no authorization of any kind in the
// body - reachable by anyone who knew the URL. The worst of them took a
// query string, selected raw_events across every tenant with the admin
// connection, decrypted the bodies and returned them.
//
// verify_jwt = true would not have been the fix. A valid Supabase JWT proves
// somebody signed up; it says nothing about whether they may read every
// tenant's mail. These endpoints have no user identity at all - they are
// called by an operator or a scheduler - so the right credential is a
// server-only shared secret, not a user token.
//
// Set as the INTERNAL_FUNCTION_KEY Edge Function secret. Callers send it as
// `Authorization: Bearer <key>` or `x-internal-key: <key>`.
//
// The secret may hold several comma-separated keys, one per operator, so a
// single person's access can be withdrawn without rotating the value the cron
// jobs depend on. Logs record which key authorised a call by digest prefix.

/**
 * Length-independent, content constant-time comparison.
 *
 * A plain `a === b` on a secret leaks its prefix through timing: an attacker
 * who can measure the difference can recover the key character by character.
 * Comparing digests of fixed length also removes the length side channel,
 * which a naive constant-time loop over the raw strings would still expose.
 */
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * A short, non-reversible label for a key, for logs only.
 *
 * Eight hex characters of SHA-256: enough to tell operators apart when
 * reading function logs, useless for reconstructing the key. Never log the
 * key itself, and never return either one in a response body.
 */
async function keyFingerprint(key: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(d).slice(0, 4))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * x-internal-key is checked FIRST, and the order is load-bearing.
 *
 * Supabase's own gateway sits in front of these functions and wants an
 * `Authorization: Bearer <supabase key>` (or `apikey`) header of its own before
 * it will route anything. So a caller who has to satisfy both ends up sending
 * the platform's key in Authorization and the internal secret in
 * x-internal-key - and with Authorization checked first, the platform key was
 * read as the presented secret and every such call was rejected as
 * unauthorised. Correct outcome, useless reason.
 *
 * Authorization is still accepted, for callers that reach the function
 * directly without the gateway in between.
 */
function presentedKey(req: Request): string {
  const direct = (req.headers.get("x-internal-key") ?? "").trim();
  if (direct) return direct;

  const header = req.headers.get("Authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

/**
 * Returns a 401/503 Response when the caller is not authorised, or null when
 * the request may proceed.
 *
 * Fails CLOSED when INTERNAL_FUNCTION_KEY is unset. A missing secret is a
 * deployment mistake, and treating it as "no check required" would recreate
 * exactly the hole this is closing - quietly, and only in the environment
 * where the secret was forgotten.
 */
export async function requireInternalKey(req: Request): Promise<Response | null> {
  const expected = Deno.env.get("INTERNAL_FUNCTION_KEY") ?? "";
  if (!expected) {
    console.error("INTERNAL_FUNCTION_KEY is not set - refusing all requests");
    return new Response(
      JSON.stringify({ error: "Endpoint is not configured" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  // INTERNAL_FUNCTION_KEY may hold SEVERAL keys, comma-separated: one per
  // operator rather than one for the team.
  //
  // WHY. A single shared value gates admin-health, admin-pipeline-status,
  // admin-detect-channels and admin-replay, which between them decrypt
  // raw_events across every tenant and spend the model budget. Handing that
  // one value to each new engineer means it can never be withdrawn from any
  // of them individually: revoking for one person is a rotation for
  // everybody, including the cron jobs that call these endpoints every
  // minute. So in practice it never gets rotated, and the blast radius only
  // grows. Giving each operator their own line means a key can be deleted on
  // its own, the same afternoon, touching nothing else.
  //
  // Empty entries are ignored so a trailing comma is harmless, but a value of
  // only separators leaves no keys at all and must fail closed like an unset
  // secret rather than admitting everyone.
  const keys = expected.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
  if (keys.length === 0) {
    console.error("INTERNAL_FUNCTION_KEY contains no usable keys - refusing all requests");
    return new Response(
      JSON.stringify({ error: "Endpoint is not configured" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  const presented = presentedKey(req);

  // Every key is compared even after one matches, and the results are OR-ed
  // at the end. Returning early on the first hit would make the response time
  // depend on WHICH key was sent, which leaks the key's position in the list -
  // a small leak, but the whole reason secretsMatch exists is that this file
  // does not accept small leaks in comparisons against secrets.
  let matched = false;
  let matchedIndex = -1;
  if (presented) {
    for (let i = 0; i < keys.length; i++) {
      if (await secretsMatch(presented, keys[i])) {
        matched = true;
        if (matchedIndex < 0) matchedIndex = i;
      }
    }
  }

  if (matched) {
    // Which key, never the key. The digest prefix is enough to tell one
    // operator's calls from another's in the logs, so a key can be traced and
    // retired on evidence, and it reveals nothing that helps forge a request.
    console.log(
      `[internal-auth] authorised via key #${matchedIndex + 1} (${await keyFingerprint(keys[matchedIndex])})`,
    );
  }

  if (!presented || !matched) {
    // Deliberately uninformative: a caller without the key learns only that
    // they need one, not whether the endpoint exists or what it does.
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  return null;
}
