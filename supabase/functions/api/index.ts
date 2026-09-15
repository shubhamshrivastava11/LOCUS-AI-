// supabase/functions/api/index.ts
//
// Deno port of the FastAPI backend's live-traffic routes (backend/src/modules/
// auth, decisions, search, digest, billing). Railway's account ran out of
// credits a second time and took down the API service itself (not just the
// worker - see ai-worker/index.ts for that earlier migration), breaking every
// dashboard feature at once since they all depend on /auth/session first.
// This finishes the migration: the frontend now talks to this function
// instead of Railway, and Railway stops being a dependency entirely.
//
// One exception, disclosed rather than silently dropped: POST /search's
// cross-encoder reranking step (modules.retrieval.reranking.cross_encoder,
// sentence_transformers/torch) has no Deno/Edge-Function equivalent - no
// local ML model runtime exists here. That module already fails OPEN on any
// error (falls back to input order), so skipping it here reproduces exactly
// that fallback path, always, rather than emulating a Python-only dependency.
// metadata.reranked is set to false so this is visible in the response, not
// hidden. Retrieval quality still benefits from hybrid RRF fusion (vector +
// keyword) - only the extra cross-encoder re-ordering pass is missing.
//
// The Stripe webhook receiver (POST /billing/webhook) is NOT ported here -
// it's called by Stripe itself (not the frontend), needs signature
// verification against STRIPE_WEBHOOK_SECRET, and Stripe's dashboard would
// need to be repointed at a new URL. Only POST /billing/checkout (the
// frontend-initiated call) is ported.

import { withAdmin, withTenant } from "../_shared/db.ts";
import { cleanDisplayText } from "../_shared/htmlText.ts";
import { decryptToken } from "../_shared/tokenCrypto.ts";
import { enforceUserPromptLimit, PromptLimitExceededError } from "../_shared/userLimits.ts";
import { enforceRouteRateLimit, RouteRateLimitExceededError } from "../_shared/routeRateLimit.ts";
import * as jose from "npm:jose@5";
import { getCurrentTenant, PERSONAL_SOURCES, resolvePermissionScopes, type TenantContext } from "../_shared/tenantAuth.ts";
import { Trace } from "../_shared/trace.ts";
import { parseAsOf } from "../_shared/temporal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-region",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, detail: string): Response {
  return jsonResponse({ detail }, status);
}

// Mirrors the Python 429's shape (backend/src/modules/ratelimit/limiter.py) -
// same Retry-After header, same detail message.
function routeRateLimitResponse(err: RouteRateLimitExceededError): Response {
  return new Response(JSON.stringify({ detail: err.message }), {
    status: 429,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": String(err.retryAfterSeconds) },
  });
}

// Mirrors the Python 429's shape (backend/src/modules/ratelimit/user_limits.py) -
// same headers, same detail message format - so any client-side handling
// written against that response shape still works against this one.
function promptLimitResponse(err: PromptLimitExceededError): Response {
  const { promptCount, limit, windowEnd } = err.usage;
  const retryAfterSeconds = Math.max(0, Math.round((windowEnd.getTime() - Date.now()) / 1000));
  return new Response(
    JSON.stringify({
      detail: `Weekly prompt limit exceeded (${promptCount}/${limit}). ` +
        `Window resets on ${windowEnd.toISOString().replace("T", " ").slice(0, 19)} UTC.`,
    }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
        "X-PromptLimit": String(limit),
        "X-PromptUsed": String(promptCount),
        "X-PromptRemaining": String(Math.max(0, limit - promptCount)),
        "X-WindowReset": windowEnd.toISOString(),
      },
    },
  );
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set - add it to Edge Function secrets`);
  return value;
}

// ── fetch() with a hard timeout (same rationale as ai-worker/index.ts:
// plain fetch() never times out on its own, which caused stuck invocations
// there - applying the same guard here for the same reason) ────────────────
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Decryption (reverse of ai-worker/index.ts's encryptRawContent, same
// AES-256-GCM / "LOCUS1" blob format) - needed to reconstruct the actual
// conversation thread behind a decision from the encrypted raw_events it
// came from, not just the single triggering message. ──────────────────────

const LOCUS_MAGIC = new TextEncoder().encode("LOCUS1");
const NONCE_LEN = 12;

async function getAesKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("RAW_EVENTS_ENCRYPTION_KEY") || Deno.env.get("APP_SECRET_KEY");
  if (!secret) throw new Error("RAW_EVENTS_ENCRYPTION_KEY or APP_SECRET_KEY is not set");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["decrypt"]);
}

async function decryptRawContent(encrypted: Uint8Array): Promise<string> {
  const key = await getAesKey();
  const nonce = encrypted.slice(LOCUS_MAGIC.length, LOCUS_MAGIC.length + NONCE_LEN);
  const ciphertext = encrypted.slice(LOCUS_MAGIC.length + NONCE_LEN);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

// notion-poller stores raw_content as the entire raw Notion API page object
// (properties, ids, timestamps, everything), not flat text - reads a
// human-readable value back out of each property by its Notion type,
// instead of dumping the whole structure as JSON.
// deno-lint-ignore no-explicit-any
function notionPropertyText(prop: any): string | null {
  if (!prop || typeof prop !== "object") return null;
  switch (prop.type) {
    case "title":
    case "rich_text": {
      const parts = (prop[prop.type] ?? []).map((t: { plain_text?: string }) => t.plain_text).filter(Boolean);
      return parts.length > 0 ? parts.join("") : null;
    }
    case "select":
      return prop.select?.name ?? null;
    case "status":
      return prop.status?.name ?? null;
    case "multi_select": {
      const names = (prop.multi_select ?? []).map((s: { name?: string }) => s.name).filter(Boolean);
      return names.length > 0 ? names.join(", ") : null;
    }
    case "date":
      return prop.date?.start ?? null;
    case "number":
      return prop.number !== null && prop.number !== undefined ? String(prop.number) : null;
    case "checkbox":
      return prop.checkbox ? "yes" : null;
    case "email":
    case "url":
    case "phone_number":
      return prop[prop.type] ?? null;
    case "people": {
      const names = (prop.people ?? []).map((p: { name?: string }) => p.name).filter(Boolean);
      return names.length > 0 ? names.join(", ") : null;
    }
    default:
      return null;
  }
}

// deno-lint-ignore no-explicit-any
function extractNotionPageText(page: any): string {
  const properties = page.properties ?? {};
  const titleEntry = Object.entries(properties).find(([, p]: [string, any]) => p?.type === "title");
  const title = titleEntry ? notionPropertyText(titleEntry[1]) : null;

  const lines: string[] = [];
  if (title) lines.push(title);
  for (const [name, prop] of Object.entries(properties)) {
    if (titleEntry && name === titleEntry[0]) continue;
    const value = notionPropertyText(prop);
    if (value) lines.push(`${name}: ${value}`);
  }
  // Same body_text ai-worker extracts from, so a citation shows the reader the
  // same page content the extraction actually saw.
  const body = typeof page.body_text === "string" ? page.body_text.trim() : "";
  if (body) lines.push(body);
  return lines.length > 0 ? lines.join("\n") : (page.url ?? "Notion page");
}

// Same field-extraction rules as modules.retrieval.service.extract_event_text:
// Gmail gets its subject prefixed onto the body; Notion reads its page
// properties into readable text (see extractNotionPageText); everything
// else falls back to the first populated text-shaped field, never
// invents content.
// Reads back envelope.raw_content.body exactly as gmail-manual-sync stored
// it. That's clean plain text for anything ingested after the source-side
// HTML fix, but rows captured before that fix (or any other future gap)
// have raw HTML baked permanently into the encrypted blob - re-extracting
// isn't possible since only the processed body was ever stored, not the
// original MIME payload. cleanDisplayText() is the defensive fallback: it
// strips HTML if the stored text still looks like markup, and swaps in a
// plain placeholder if nothing readable survives, rather than rendering a
// wall of raw tags (or a near-empty fragment like a stray "96" from a style
// attribute) straight into the conversation thread.
function extractEventText(rawContent: unknown, source: string): string {
  if (!rawContent || typeof rawContent !== "object") return cleanDisplayText(String(rawContent ?? ""));
  const content = rawContent as Record<string, unknown>;
  if (source === "gmail") {
    const subject = typeof content.subject === "string" ? content.subject : "";
    const body = typeof content.body === "string" ? cleanDisplayText(content.body) : "";
    return subject ? `Subject: ${subject}\n${body}` : body;
  }
  if (source === "notion" && "properties" in content) {
    return cleanDisplayText(extractNotionPageText(content));
  }
  for (const field of ["text", "body", "content", "message", "description", "snippet"]) {
    const val = content[field];
    if (typeof val === "string" && val) return cleanDisplayText(val);
  }
  return cleanDisplayText(JSON.stringify(content));
}

type ThreadMessage = { at: string; actor: string; source: string; text: string; is_source: boolean };

// Discord's own mention syntax (<@123...> user, <@!123...> nickname form) -
// resolved the same way an actual sender is: against the tenant's actors
// table, using the exact map buildThreadContext already builds for that.
// Scoped to Discord only since no other connector emits this bracket
// syntax. Real bug found live: a message like "Hi <@1234567890>" rendered
// literally in the reconstructed conversation instead of "Hi @Rajith" -
// only the message's own *sender* was ever being resolved to a name, never
// people mentioned inside the message body. Only fixes messages ingested
// after this deploy - a mention already mangled into "<@[REDACTED-NUMBER]>"
// by the financialRedaction over-broad digit-run pass (see that file's own
// fix) had its real id destroyed before it was ever stored, so there's
// nothing left here to resolve for those older rows.
function resolveDiscordMentions(text: string, actorNameByRawId: Map<string, string>): string {
  return text.replace(/<@!?(\d{15,25})>/g, (full, id: string) => {
    const name = actorNameByRawId.get(id);
    return name ? `@${name}` : full;
  });
}

// postgres.js's bytea decoding varies by how the column comes back over the
// wire - normally a Uint8Array/Buffer, but a hex-encoded "\x4c4f..." string
// (Postgres's default bytea_output) is also possible depending on the
// driver path taken. Handle both rather than assuming one.
function byteaToUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }
  return new Uint8Array(value as ArrayLike<number>);
}

// The actors table only ever has a row for people extracted as an actual
// decision participant (role decided_by/mentioned) - someone who just
// chatted in the reconstructed thread without ever being named in a
// decision has no row to look up. Falls back to a live Slack users.info
// call per unresolved id (bounded, only for ids that miss the table), and
// caches the result back into actors so the next lookup is a normal
// table hit instead of another live call.
// deno-lint-ignore no-explicit-any
async function resolveSlackNamesLive(sql: any, tenantId: string, slackUserIds: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (slackUserIds.length === 0) return resolved;

  try {
    const connRows = await sql`
      SELECT oauth_token_ref FROM public.source_connections
      WHERE tenant_id = ${tenantId} AND source = 'slack' AND status = 'active'
      ORDER BY created_at ASC LIMIT 1
    `;
    const accessToken = await decryptToken(connRows[0]?.oauth_token_ref);
    if (!accessToken) return resolved;

    for (const slackUserId of slackUserIds) {
      try {
        const resp = await fetchWithTimeout(
          `https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
          8_000,
        );
        const data = await resp.json();
        if (!data.ok) continue;
        const name = data.user?.profile?.real_name || data.user?.real_name || data.user?.name;
        if (!name) continue;
        resolved.set(slackUserId, name);

        // No unique constraint on (tenant_id, slack_user_id) exists to
        // support ON CONFLICT - select-then-insert/update instead, same
        // pattern already proven in ai-worker's resolveActorId.
        const existing = await sql`
          SELECT id FROM public.actors WHERE tenant_id = ${tenantId} AND slack_user_id = ${slackUserId}
        `;
        if (existing.length > 0) {
          await sql`UPDATE public.actors SET display_name = ${name} WHERE id = ${existing[0].id}`;
        } else {
          await sql`
            INSERT INTO public.actors (tenant_id, slack_user_id, display_name, kind)
            VALUES (${tenantId}, ${slackUserId}, ${name}, 'internal')
          `;
        }
      } catch (err) {
        console.error(`Slack users.info failed for ${slackUserId}:`, err);
      }
    }
  } catch (err) {
    console.error("resolveSlackNamesLive failed:", err);
  }
  return resolved;
}

// Reconstructs "what was the conversation that led to this decision" - not
// just the single message that got extracted, every message sharing the
// same thread_ref (a Slack thread, a Gmail thread, a Notion page's edit
// history), in chronological order. Falls back to just the directly linked
// raw_events when no thread_ref exists (e.g. a standalone Gmail message).
// Takes the caller's already-open tenant-scoped `sql` handle rather than
// opening its own nested withTenant connection - and never lets a failure
// here take down the whole decision fetch, since this is a quality
// enrichment, not core data; fails open to an empty thread on any error.
// Real bug found live: thread_ref means "one genuine conversation" for
// every connector except Discord, where the poller sets it to the whole
// channel ID (discord-poller/index.ts) - there's no cheaper per-message
// grouping available yet (Discord's real reply-chain data isn't captured
// during ingestion). Left unbounded, this function pulled a channel's
// *entire* ingested history as "conversation" for any one decision from
// it. Fixed with a time window around the origin event(s) plus a hard
// row cap - harmless for Slack/Gmail/Jira/Confluence/Notion (their
// thread_ref is already a tight, naturally short-lived container so the
// window never binds), and it's what actually fixes Discord: only
// messages near the decision in time now show up, not the channel's
// whole lifetime. Pure SQL - no embedding or LLM call involved, so this
// adds zero token cost.
//
// Real gap found by checking a live decision against this fix, not
// assumed: the time window alone doesn't help when a channel's whole
// history happens to sit inside one continuous burst - checked directly
// against the "Trial solution is now live" Discord decision and all 46
// of that channel's messages fell inside the 6h window, because a small
// team's single Discord channel genuinely interleaves several unrelated
// topics in real time, not spread across days. That's a topical problem,
// not a chronological one, so only a topical filter can fix it. Below,
// once a thread has more than a handful of candidate messages, the
// decision's own statement and every candidate message are embedded
// (Voyage, same model/dimension already used for decision_embeddings)
// and only the messages most semantically related to the decision are
// kept - the origin/source event(s) are always force-kept regardless of
// score, since those are the actual evidence the decision was extracted
// from, not just similar-sounding context. This is the one place in the
// app where per-view embedding cost is worth it: cheap Voyage calls, not
// Claude, proportional to how many decisions people actually open, and
// it's solving a problem the time window structurally cannot.
const THREAD_CONTEXT_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h either side of the origin event(s)
const THREAD_CONTEXT_MAX_MESSAGES = 40;
const THREAD_CONTEXT_RELEVANCE_MIN_MESSAGES = 12; // below this, just show everything - not worth an embedding call
const THREAD_CONTEXT_RELEVANCE_TOP_K = 20;

// deno-lint-ignore no-explicit-any
async function buildThreadContext(
  sql: any,
  tenantId: string,
  originRawEventId: string | null,
  sourceRawEventIds: string[],
  decisionStatement: string | null,
): Promise<ThreadMessage[]> {
  const rawEventIds = [...new Set([originRawEventId, ...sourceRawEventIds].filter((id): id is string => !!id))];
  if (rawEventIds.length === 0) return [];

  try {
    const originRows = await sql`
      SELECT thread_ref, received_at FROM public.raw_events
      WHERE id = ANY(${rawEventIds}) AND tenant_id = ${tenantId}
    `;
    const threadRefs = [
      ...new Set(originRows.map((r: { thread_ref: string | null }) => r.thread_ref).filter((v: string | null): v is string => !!v)),
    ];
    const originTimes = originRows
      .map((r: { received_at: string }) => new Date(r.received_at).getTime())
      .filter((t: number) => !Number.isNaN(t));
    const windowStart = originTimes.length > 0
      ? new Date(Math.min(...originTimes) - THREAD_CONTEXT_WINDOW_MS).toISOString()
      : null;
    const windowEnd = originTimes.length > 0
      ? new Date(Math.max(...originTimes) + THREAD_CONTEXT_WINDOW_MS).toISOString()
      : null;

    // raw_events has no plain-text "actor" column - only actor_id (a
    // foreign key the current ingestion pipeline never populates). The
    // real actor identity only ever existed inside the encrypted envelope
    // itself, which is already being decrypted below anyway.
    const eventRows = threadRefs.length > 0
      ? (windowStart && windowEnd
        ? await sql`
            SELECT id, source, received_at, raw_content FROM public.raw_events
            WHERE thread_ref = ANY(${threadRefs}) AND tenant_id = ${tenantId}
              AND received_at BETWEEN ${windowStart} AND ${windowEnd}
            ORDER BY received_at ASC
            LIMIT ${THREAD_CONTEXT_MAX_MESSAGES}
          `
        : await sql`
            SELECT id, source, received_at, raw_content FROM public.raw_events
            WHERE thread_ref = ANY(${threadRefs}) AND tenant_id = ${tenantId}
            ORDER BY received_at ASC
            LIMIT ${THREAD_CONTEXT_MAX_MESSAGES}
          `)
      : await sql`
          SELECT id, source, received_at, raw_content FROM public.raw_events
          WHERE id = ANY(${rawEventIds}) AND tenant_id = ${tenantId}
          ORDER BY received_at ASC
        `;

    // deno-lint-ignore no-explicit-any
    const decrypted: { id: string; at: string; rawActor: string; source: string; text: string; isSource: boolean }[] = [];
    for (const row of eventRows) {
      try {
        const bytes = byteaToUint8Array(row.raw_content);
        const plaintext = await decryptRawContent(bytes);
        const envelope = JSON.parse(plaintext) as { raw_content?: unknown; actor?: string };
        const text = extractEventText(envelope.raw_content, row.source);
        decrypted.push({
          id: row.id,
          at: row.received_at,
          rawActor: envelope.actor ?? "unknown",
          source: row.source,
          text,
          isSource: rawEventIds.includes(row.id),
        });
      } catch (err) {
        console.error(`Failed to decrypt/parse raw_event ${row.id}:`, err);
      }
    }

    // Topical relevance filter - see the function header for why the time
    // window alone isn't enough. Only kicks in once there's actually
    // something to trim; a normal-sized thread skips this entirely, so
    // the added embedding cost is never paid for the common case.
    let relevant = decrypted;
    if (decisionStatement && decrypted.length > THREAD_CONTEXT_RELEVANCE_MIN_MESSAGES) {
      try {
        const [statementEmbedding, messageEmbeddings] = await Promise.all([
          embedQuery(decisionStatement),
          embedBatch(decrypted.map((m) => m.text), "document"),
        ]);
        const scored = decrypted.map((m, i) => ({ m, score: cosineSimilarity(statementEmbedding, messageEmbeddings[i]) }));
        const mustKeep = scored.filter((s) => s.m.isSource);
        const rest = scored.filter((s) => !s.m.isSource).sort((a, b) => b.score - a.score);
        const budget = Math.max(0, THREAD_CONTEXT_RELEVANCE_TOP_K - mustKeep.length);
        relevant = [...mustKeep, ...rest.slice(0, budget)]
          .map((s) => s.m)
          .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      } catch (err) {
        // Fails open to the time-windowed set, unfiltered - a relevance
        // enrichment breaking is not a reason to hide the conversation
        // entirely.
        console.error("thread-context relevance filter failed, falling back to time-windowed set:", err);
      }
    }

    // Envelopes only ever carry the raw platform identifier (a Slack "U..."
    // id, a Notion user id, a Gmail address, an Atlassian accountId, a
    // Discord user id) - resolve to real names the same way decision
    // participants already are, instead of showing raw ids in the
    // reconstructed conversation.
    //
    // Real bug found live: this query's WHERE clause only ever matched
    // slack_user_id/notion_user_id/email, structurally excluding Jira/
    // Confluence/Discord actors from ever being found here at all -
    // unlike listDecisions/getDecision's own actor resolution, which joins
    // by the actors table's internal UUID (source-agnostic, unaffected by
    // this), buildThreadContext re-derives identity from the raw platform
    // id carried in each event's own envelope, so it needed the same
    // 3-column list every other actor-identifier lookup already needed
    // extending. Confirmed live: a real Discord conversation showed the
    // raw snowflake id instead of a name.
    const rawActorIds = [...new Set(relevant.map((m) => m.rawActor))];
    const actorNameByRawId = new Map<string, string>();
    if (rawActorIds.length > 0) {
      const actorRows = await sql`
        SELECT display_name, email, notion_user_id, slack_user_id, atlassian_account_id, discord_user_id, github_user_id, monday_user_id, clickup_user_id FROM public.actors
        WHERE tenant_id = ${tenantId}
          AND (slack_user_id = ANY(${rawActorIds}) OR notion_user_id = ANY(${rawActorIds}) OR email = ANY(${rawActorIds})
            OR atlassian_account_id = ANY(${rawActorIds}) OR discord_user_id = ANY(${rawActorIds}) OR github_user_id = ANY(${rawActorIds})
            OR monday_user_id = ANY(${rawActorIds}) OR clickup_user_id = ANY(${rawActorIds}))
      `;
      for (const ar of actorRows) {
        const name = guessActorName(ar.display_name, ar.email, ar.notion_user_id, ar.slack_user_id);
        if (!name) continue;
        for (const rawId of [ar.slack_user_id, ar.notion_user_id, ar.email, ar.atlassian_account_id, ar.discord_user_id, ar.github_user_id, ar.monday_user_id, ar.clickup_user_id]) {
          if (rawId) actorNameByRawId.set(rawId, name);
        }
      }
    }

    const unresolvedSlackIds = rawActorIds.filter((id) => !actorNameByRawId.has(id) && SLACK_USER_ID_RE.test(id));
    if (unresolvedSlackIds.length > 0) {
      const liveResolved = await resolveSlackNamesLive(sql, tenantId, unresolvedSlackIds);
      for (const [id, name] of liveResolved) actorNameByRawId.set(id, name);
    }

    return relevant.map((m) => ({
      at: m.at,
      actor: actorNameByRawId.get(m.rawActor) ?? m.rawActor,
      source: m.source,
      text: m.source === "discord" ? resolveDiscordMentions(m.text, actorNameByRawId) : m.text,
      is_source: m.isSource,
    }));
  } catch (err) {
    console.error("buildThreadContext query failed:", err);
    return [];
  }
}

// ── Auth: Supabase token verification + tenant-scoped JWT issuance ────────
// Mirrors backend/src/modules/auth/service.py + supabase_verifier.py exactly:
// verify the Supabase-issued access_token via JWKS, look up the caller's
// first membership row via the admin (bypass-RLS) connection, then sign a
// tenant-scoped HS256 JWT with the same claim shape
// (iss=locus-ai, sub=user_id, tenant_id, role, iat, exp).

let _jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
function getSupabaseJwks() {
  if (_jwks) return _jwks;
  const base = requireEnv("SUPABASE_URL").replace(/\/$/, "");
  _jwks = jose.createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`));
  return _jwks;
}

async function verifySupabaseToken(token: string): Promise<string> {
  const { payload } = await jose.jwtVerify(token, getSupabaseJwks(), { audience: "authenticated" });
  if (!payload.sub) throw new Error("Supabase JWT missing 'sub' claim");
  return payload.sub;
}

const TENANT_JWT_ISSUER = "locus-ai";
const TENANT_JWT_TTL_SECONDS = 86_400;

async function signTenantJwt(userId: string, tenantId: string, role: string): Promise<string> {
  const secret = new TextEncoder().encode(requireEnv("APP_SECRET_KEY"));
  const now = Math.floor(Date.now() / 1000);
  return await new jose.SignJWT({ tenant_id: tenantId, role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(TENANT_JWT_ISSUER)
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + TENANT_JWT_TTL_SECONDS)
    .sign(secret);
}

// verifyTenantJwt/getCurrentTenant/resolvePermissionScopes now live in
// ../_shared/tenantAuth.ts (also used by memory-api's Memory Timeline and
// evidence-drawer endpoints) - moved so a second function authenticating
// real users doesn't grow its own hand-copied, silently-drifting version.

// ── Handler: POST /auth/session ────────────────────────────────────────
async function handleAuthSession(req: Request): Promise<Response> {
  // Traced because this sits on the critical path of every page load: the
  // browser cannot show anything tenant-scoped until it has exchanged for a
  // tenant token, so its cost is felt on every refresh.
  const authTrace = new Trace();
  let body: { supabase_token?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  if (!body.supabase_token) return errorResponse(400, "supabase_token is required");

  let authUserId: string;
  try {
    authUserId = await verifySupabaseToken(body.supabase_token);
  } catch (err) {
    return errorResponse(401, `Invalid Supabase token: ${err instanceof Error ? err.message : String(err)}`);
  }

  const membership = await withAdmin(async (sql) => {
    const rows = await sql`
      SELECT m.tenant_id, m.role, t.plan FROM memberships m
      JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = ${authUserId}
      ORDER BY m.created_at ASC LIMIT 1
    `;
    return rows[0] ?? null;
  });

  if (membership === null) {
    return errorResponse(
      401,
      `No tenant membership found for user ${authUserId}. The account may not have been provisioned correctly.`,
    );
  }

  authTrace.mark("load_membership");

  const tenantId = membership.tenant_id as string;
  const role = membership.role as string;
  const plan = membership.plan as string;
  const token = await signTenantJwt(authUserId, tenantId, role);
  authTrace.mark("sign_jwt");
  void authTrace.write(tenantId, "POST /auth/session");

  return jsonResponse({ token, tenant_id: tenantId, role, plan, expires_in: TENANT_JWT_TTL_SECONDS });
}

// ── Decisions: list + get (mirrors modules/decisions/service.py) ─────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLACK_USER_ID_RE = /^U[A-Z0-9]{6,}$/;

function guessActorName(
  displayName: string | null, email: string | null,
  notionUserId: string | null, slackUserId: string | null,
): string | null {
  if (displayName) return displayName;
  if (email) return email;
  if (notionUserId && !UUID_RE.test(notionUserId)) return notionUserId;
  if (slackUserId && !SLACK_USER_ID_RE.test(slackUserId)) return slackUserId;
  return null;
}

// deno-lint-ignore no-explicit-any
function buildDecisionOut(row: any, actors: unknown[], sourceLinks: string[], sourcePlatforms: string[]) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    record_type: row.record_type,
    decision_statement: row.decision_statement,
    rationale: row.rationale ?? null,
    alternatives_considered: row.alternatives_considered ?? [],
    actors,
    status: row.status,
    superseded_by: row.superseded_by ?? null,
    scope: row.scope,
    confidence: Number(row.confidence),
    source_links: sourceLinks,
    source_platforms: sourcePlatforms,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Temporal memory model: valid_until null means this is current.
    valid_from: row.valid_from ?? row.created_at,
    valid_until: row.valid_until ?? null,
  };
}

async function listDecisions(
  tenantId: string,
  userId: string,
  limit: number,
  offset: number,
  recordType?: string | null,
  source?: string | null,
  asOf?: string | null,
) {
  return await withTenant(tenantId, async (sql) => {
    // Temporal memory model (see the 20260909100000 migration). Without
    // as_of this is the live view: only memories that are still true.
    // With as_of it reconstructs what the organization believed at that
    // moment - a memory that has since been superseded reappears, because
    // back then it had not been. Costs nothing but a WHERE clause; there
    // is no model call anywhere on this path.
    const temporalFilter = asOf
      ? sql`AND d.valid_from <= ${asOf}::timestamptz
            AND (d.valid_until IS NULL OR d.valid_until > ${asOf}::timestamptz)`
      : sql`AND d.superseded_by IS NULL`;
    // Memory Explorer and the Decision Log filtered on tenant_id alone, so
    // a decision extracted from one member's personal mailbox was listed
    // for the whole team - regardless of the scope checks /search applies,
    // which this path never ran at all. Excludes decisions whose origin
    // connection is a PERSONAL_SOURCES connection owned by somebody else;
    // unattributed legacy rows stay visible, same reasoning as
    // resolvePermissionScopes.
    const personalFilter = sql`
      AND NOT EXISTS (
        SELECT 1
        FROM public.raw_events pre
        JOIN public.source_connections psc
          ON psc.id = pre.connection_id AND psc.tenant_id = pre.tenant_id
        WHERE pre.id = d.origin_raw_event_id
          AND pre.tenant_id = d.tenant_id
          AND psc.source = ANY(${[...PERSONAL_SOURCES]}::text[])
          AND psc.connected_by IS NOT NULL
          AND psc.connected_by <> ${userId}::uuid
      )
    `;
    // Filtering happens here, not client-side, so "Gmail only" (etc.) reflects
    // the full archive across all pages, not just whatever page was loaded
    // before the filter was picked.
    const recordTypeFilter = recordType ? sql`AND d.record_type = ${recordType}` : sql``;
    const sourceFilter = source ? sql`AND re.source = ${source}` : sql``;

    // Superseded rows (duplicates ai-worker's conflict detection already
    // resolved, or the admin-dedupe-decisions backfill resolved) are
    // excluded from the default feed - they're kept in the table for audit
    // history via decisions.superseded_by, but a resolved duplicate showing
    // up next to the entry it duplicates is exactly the clutter this is
    // supposed to prevent.
    const rows = await sql`
      SELECT d.id, d.tenant_id, d.record_type, d.decision_statement, d.rationale,
             d.alternatives_considered, d.status, d.superseded_by, d.scope, d.confidence,
             d.origin_raw_event_id, d.created_at, d.updated_at,
             d.valid_from, d.valid_until
      FROM decisions d
      LEFT JOIN raw_events re ON re.id = d.origin_raw_event_id AND re.tenant_id = d.tenant_id
      WHERE d.tenant_id = ${tenantId} ${temporalFilter} ${recordTypeFilter} ${sourceFilter} ${personalFilter}
      ORDER BY d.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
    const totalRows = await sql`
      SELECT COUNT(*)::int AS total
      FROM decisions d
      LEFT JOIN raw_events re ON re.id = d.origin_raw_event_id AND re.tenant_id = d.tenant_id
      WHERE d.tenant_id = ${tenantId} ${temporalFilter} ${recordTypeFilter} ${sourceFilter} ${personalFilter}
    `;
    const total = totalRows[0]?.total ?? 0;

    const decisionIds = rows.map((r) => r.id);
    // deno-lint-ignore no-explicit-any
    const actorsByDec = new Map<string, any[]>();
    const sourcesByDec = new Map<string, string[]>();
    const platformsByDec = new Map<string, string[]>();

    if (decisionIds.length > 0) {
      const actorRows = await sql`
        SELECT da.decision_id, da.actor_id, da.role,
               a.display_name, a.email, a.notion_user_id, a.slack_user_id
        FROM decision_actors da
        LEFT JOIN public.actors a ON a.id = da.actor_id AND a.tenant_id = da.tenant_id
        WHERE da.decision_id = ANY(${decisionIds}) AND da.tenant_id = ${tenantId}
      `;
      for (const ar of actorRows) {
        const list = actorsByDec.get(ar.decision_id) ?? [];
        list.push({
          id: String(ar.actor_id), role: ar.role,
          name: guessActorName(ar.display_name, ar.email, ar.notion_user_id, ar.slack_user_id),
        });
        actorsByDec.set(ar.decision_id, list);
      }

      const sourceRows = await sql`
        SELECT decision_id, permalink FROM decision_sources
        WHERE decision_id = ANY(${decisionIds}) AND tenant_id = ${tenantId}
      `;
      for (const sr of sourceRows) {
        const list = sourcesByDec.get(sr.decision_id) ?? [];
        list.push(sr.permalink);
        sourcesByDec.set(sr.decision_id, list);
      }

      const originIds = rows.map((r) => r.origin_raw_event_id).filter((id) => id);
      if (originIds.length > 0) {
        const platformRows = await sql`
          SELECT id, source FROM raw_events WHERE id = ANY(${originIds}) AND tenant_id = ${tenantId}
        `;
        const platformByOrigin = new Map(platformRows.map((p) => [p.id, p.source]));
        for (const row of rows) {
          if (row.origin_raw_event_id && platformByOrigin.has(row.origin_raw_event_id)) {
            platformsByDec.set(row.id, [platformByOrigin.get(row.origin_raw_event_id) as string]);
          }
        }
      }
    }

    const items = rows.map((row) =>
      buildDecisionOut(
        row, actorsByDec.get(row.id) ?? [], sourcesByDec.get(row.id) ?? [], platformsByDec.get(row.id) ?? [],
      )
    );
    return { items, total };
  });
}

async function getDecisionById(tenantId: string, userId: string, decisionId: string) {
  return await withTenant(tenantId, async (sql) => {
    // Scoped for the same reason listDecisions is, and it matters more
    // here: this is addressable by id, so without it a teammate who
    // learned a decision id could open one extracted from somebody else's
    // private mailbox directly, bypassing every list that hid it.
    const rows = await sql`
      SELECT id, tenant_id, record_type, decision_statement, rationale,
             alternatives_considered, status, superseded_by, scope, confidence,
             origin_raw_event_id, created_at, updated_at,
             valid_from, valid_until
      FROM decisions d
      WHERE d.id = ${decisionId} AND d.tenant_id = ${tenantId}
        AND NOT EXISTS (
          SELECT 1
          FROM public.raw_events pre
          JOIN public.source_connections psc
            ON psc.id = pre.connection_id AND psc.tenant_id = pre.tenant_id
          WHERE pre.id = d.origin_raw_event_id
            AND pre.tenant_id = d.tenant_id
            AND psc.source = ANY(${[...PERSONAL_SOURCES]}::text[])
            AND psc.connected_by IS NOT NULL
            AND psc.connected_by <> ${userId}::uuid
        )
    `;
    const row = rows[0];
    if (!row) return null;

    const actorRows = await sql`
      SELECT da.actor_id, da.role, a.display_name, a.email, a.notion_user_id, a.slack_user_id
      FROM decision_actors da
      LEFT JOIN public.actors a ON a.id = da.actor_id AND a.tenant_id = da.tenant_id
      WHERE da.decision_id = ${decisionId} AND da.tenant_id = ${tenantId}
    `;
    // A single decision has few enough participants that a live Slack
    // lookup for each still-unresolved one is cheap here - unlike
    // listDecisions, which returns up to 200 rows at once and would turn
    // into 200x live API calls if it did the same.
    const unresolvedParticipantIds = actorRows
      .filter((ar) => !guessActorName(ar.display_name, ar.email, ar.notion_user_id, ar.slack_user_id) && ar.slack_user_id)
      .map((ar) => ar.slack_user_id as string);
    const liveParticipantNames = unresolvedParticipantIds.length > 0
      ? await resolveSlackNamesLive(sql, tenantId, unresolvedParticipantIds)
      : new Map<string, string>();

    const actors = actorRows.map((ar) => ({
      id: String(ar.actor_id), role: ar.role,
      name: guessActorName(ar.display_name, ar.email, ar.notion_user_id, ar.slack_user_id)
        ?? (ar.slack_user_id ? liveParticipantNames.get(ar.slack_user_id) : undefined)
        ?? null,
    }));

    const sourceRows = await sql`
      SELECT permalink, raw_event_id FROM decision_sources WHERE decision_id = ${decisionId} AND tenant_id = ${tenantId}
    `;
    const sourceLinks = sourceRows.map((sr) => sr.permalink);

    let sourcePlatforms: string[] = [];
    let sourceReceivedAt: string | null = null;
    if (row.origin_raw_event_id) {
      const platformRows = await sql`
        SELECT source, received_at FROM raw_events WHERE id = ${row.origin_raw_event_id} AND tenant_id = ${tenantId}
      `;
      if (platformRows[0]?.source) sourcePlatforms = [platformRows[0].source];
      if (platformRows[0]?.received_at) sourceReceivedAt = platformRows[0].received_at;
    }

    // Symmetric in meaning even though stored asymmetrically (decision_id
    // is always "whichever one was captured second") - a conflict shows up
    // regardless of which side of the pair you're looking at.
    const conflictRows = await sql`
      SELECT dc.relationship, dc.reason, dc.confidence,
             CASE WHEN dc.decision_id = ${decisionId} THEN dc.related_decision_id ELSE dc.decision_id END AS other_id,
             CASE WHEN dc.decision_id = ${decisionId} THEN d2.decision_statement ELSE d1.decision_statement END AS other_statement
      FROM public.decision_conflicts dc
      JOIN public.decisions d1 ON d1.id = dc.decision_id AND d1.tenant_id = dc.tenant_id
      JOIN public.decisions d2 ON d2.id = dc.related_decision_id AND d2.tenant_id = dc.tenant_id
      WHERE dc.tenant_id = ${tenantId} AND (dc.decision_id = ${decisionId} OR dc.related_decision_id = ${decisionId})
    `;
    const conflicts = conflictRows.map((cr) => ({
      decision_id: cr.other_id, decision_statement: cr.other_statement,
      relationship: cr.relationship, reason: cr.reason, confidence: Number(cr.confidence),
    }));

    const decisionOut = buildDecisionOut(row, actors, sourceLinks, sourcePlatforms);
    return {
      ...decisionOut,
      source_received_at: sourceReceivedAt,
      conflicts,
      thread_context: await buildThreadContext(
        sql,
        tenantId,
        row.origin_raw_event_id,
        sourceRows.map((sr) => sr.raw_event_id).filter(Boolean),
        row.decision_statement ?? null,
      ),
    };
  });
}

// ── Retrieval: vector + keyword + RRF fusion (mirrors modules/retrieval) ──

const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const VOYAGE_MODEL = Deno.env.get("VOYAGE_EMBED_MODEL") ?? "voyage-4-large";
const VOYAGE_OUTPUT_DIMENSION = 1024;

async function embedQuery(text: string): Promise<number[]> {
  const resp = await fetchWithTimeout("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      input: [text], model: VOYAGE_MODEL, input_type: "query",
      output_dimension: VOYAGE_OUTPUT_DIMENSION, truncation: true,
    }),
  }, 30_000);
  if (!resp.ok) throw new Error(`Voyage API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const embedding = data.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== VOYAGE_OUTPUT_DIMENSION) {
    throw new Error("Voyage returned an unexpected embedding shape");
  }
  return embedding;
}

// Used only by buildThreadContext's relevance filter - embeds every
// candidate thread message in one batched Voyage call (Voyage's input
// array accepts multiple texts per request) rather than one call per
// message, so cost stays one request regardless of how noisy a channel
// is. input_type "document" matches how decision_embeddings itself is
// stored, mirroring the asymmetric query/document convention embedQuery
// already uses for search.
async function embedBatch(texts: string[], inputType: "query" | "document"): Promise<number[][]> {
  const resp = await fetchWithTimeout("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      input: texts, model: VOYAGE_MODEL, input_type: inputType,
      output_dimension: VOYAGE_OUTPUT_DIMENSION, truncation: true,
    }),
  }, 30_000);
  if (!resp.ok) throw new Error(`Voyage API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const embeddings: number[][] = (data.data ?? []).map((d: { embedding: number[] }) => d.embedding);
  if (embeddings.length !== texts.length) throw new Error("Voyage batch embedding count mismatch");
  return embeddings;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

type RetrievalMatch = {
  decision_id: string; decision_statement: string; similarity_score: number;
  confidence: number; permission_scope: string[]; rationale: string | null;
  alternatives_considered: string[]; created_at: string | null;
  decision_type: string | null; owner: string | null; source: string | null;
};

const OWNER_SELECT = `
  (
    SELECT COALESCE(a.display_name, a.email)
    FROM public.decision_actors da
    JOIN public.actors a ON a.id = da.actor_id AND a.tenant_id = d.tenant_id
    WHERE da.decision_id = d.id AND da.tenant_id = d.tenant_id AND da.role = 'decided_by'
    LIMIT 1
  )
`;

async function searchSimilarDecisions(
  tenantId: string, embedding: number[], topK: number, asOf?: Date | null,
): Promise<RetrievalMatch[]> {
  const vectorLiteral = "[" + embedding.join(",") + "]";
  return await withTenant(tenantId, async (sql) => {
    // Retrieval previously filtered on tenant alone, so a superseded
    // decision could be retrieved and cited as though it were still true -
    // while the Decision Log, which does exclude them, showed otherwise.
    // Same predicate as listDecisions now, and as_of additionally lets
    // search reconstruct what was true at a past moment.
    const temporalFilter = asOf
      ? sql`AND d.valid_from <= ${asOf.toISOString()}::timestamptz
            AND (d.valid_until IS NULL OR d.valid_until > ${asOf.toISOString()}::timestamptz)`
      : sql`AND d.superseded_by IS NULL`;
    const rows = await sql`
      SELECT
        d.id AS decision_id, d.decision_statement,
        1 - (de.embedding <=> ${vectorLiteral}::vector) AS similarity_score,
        d.confidence, d.permission_scope, d.rationale, d.alternatives_considered,
        d.created_at, d.record_type AS decision_type, ${sql.unsafe(OWNER_SELECT)} AS owner,
        r.source AS source
      FROM public.decision_embeddings de
      JOIN public.decisions d ON d.id = de.decision_id AND d.tenant_id = de.tenant_id
      LEFT JOIN public.raw_events r ON r.id = d.origin_raw_event_id AND r.tenant_id = d.tenant_id
      WHERE d.tenant_id = ${tenantId} ${temporalFilter}
      ORDER BY de.embedding <=> ${vectorLiteral}::vector ASC
      LIMIT ${topK}
    `;
    return rows.map((row) => ({
      decision_id: row.decision_id, decision_statement: row.decision_statement,
      similarity_score: Number(row.similarity_score), confidence: Number(row.confidence),
      permission_scope: row.permission_scope ?? [], rationale: row.rationale,
      alternatives_considered: row.alternatives_considered ?? [], created_at: row.created_at,
      decision_type: row.decision_type, owner: row.owner, source: row.source,
    }));
  });
}

async function searchDecisionsKeyword(
  tenantId: string, question: string, topK: number, asOf?: Date | null,
): Promise<RetrievalMatch[]> {
  const query = question.trim();
  if (!query) return [];
  return await withTenant(tenantId, async (sql) => {
    const temporalFilter = asOf
      ? sql`AND d.valid_from <= ${asOf.toISOString()}::timestamptz
            AND (d.valid_until IS NULL OR d.valid_until > ${asOf.toISOString()}::timestamptz)`
      : sql`AND d.superseded_by IS NULL`;
    const rows = await sql`
      SELECT
        d.id AS decision_id, d.decision_statement,
        ts_rank(
          to_tsvector('english', d.decision_statement || ' ' || COALESCE(d.rationale, '')),
          websearch_to_tsquery('english', ${query})
        ) AS similarity_score,
        d.confidence, d.permission_scope, d.rationale, d.alternatives_considered,
        d.created_at, d.record_type AS decision_type, ${sql.unsafe(OWNER_SELECT)} AS owner,
        r.source AS source
      FROM public.decisions d
      LEFT JOIN public.raw_events r ON r.id = d.origin_raw_event_id AND r.tenant_id = d.tenant_id
      WHERE d.tenant_id = ${tenantId} ${temporalFilter}
        AND to_tsvector('english', d.decision_statement || ' ' || COALESCE(d.rationale, ''))
            @@ websearch_to_tsquery('english', ${query})
      ORDER BY similarity_score DESC, d.created_at DESC
      LIMIT ${topK}
    `;
    return rows.map((row) => ({
      decision_id: row.decision_id, decision_statement: row.decision_statement,
      similarity_score: Number(row.similarity_score), confidence: Number(row.confidence),
      permission_scope: row.permission_scope ?? [], rationale: row.rationale,
      alternatives_considered: row.alternatives_considered ?? [], created_at: row.created_at,
      decision_type: row.decision_type, owner: row.owner, source: row.source,
    }));
  });
}

const DEFAULT_RRF_K = 60;

// Recency re-rank: created_at was only ever a keyword-search tiebreaker
// inside fuseRrf's tie cases, never an actual re-rank stage - a
// month-old decision with marginally higher vector similarity could
// permanently outrank yesterday's near-equally-relevant one for "what did
// we decide recently?"-style questions. This nudges scores toward fresher
// matches without letting recency override a real relevance gap: the
// multiplier decays from 2x (today) to 1x (RECENCY_HALF_LIFE_DAYS old) to
// approaching 1x asymptotically for anything older, so a much stronger RRF
// score still wins over a much fresher weak one. No created_at (shouldn't
// happen, but the type allows null) gets no boost, same as year-old items.
const RECENCY_HALF_LIFE_DAYS = 14;
const RECENCY_MAX_BOOST = 1.0;

function recencyMultiplier(createdAt: string | null, now: number): number {
  if (!createdAt) return 1;
  const ageDays = Math.max(0, (now - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000));
  const decay = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return 1 + RECENCY_MAX_BOOST * decay;
}

function fuseRrf(vectorMatches: RetrievalMatch[], keywordMatches: RetrievalMatch[], topK: number, k = DEFAULT_RRF_K): RetrievalMatch[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, RetrievalMatch>();
  for (const list of [vectorMatches, keywordMatches]) {
    list.forEach((match, index) => {
      const rank = index + 1;
      scores.set(match.decision_id, (scores.get(match.decision_id) ?? 0) + 1 / (k + rank));
      if (!byId.has(match.decision_id)) byId.set(match.decision_id, match);
    });
  }
  const now = Date.now();
  const blended = new Map<string, number>();
  for (const [id, score] of scores) {
    const match = byId.get(id)!;
    blended.set(id, score * recencyMultiplier(match.created_at, now));
  }
  const fused = [...byId.values()].sort((a, b) => (blended.get(b.decision_id)! - blended.get(a.decision_id)!));
  return fused.slice(0, topK);
}

async function hybridRetrieve(
  tenantId: string, question: string, topK: number, candidateK: number,
  embeddingQuery: string, keywordQuery: string,
  // Callers that already have an embedding in flight in parallel with other
  // work (see handleSearch) can pass it here to skip a redundant embedQuery
  // call. Falls back to computing it inline, same as before, when omitted.
  precomputedEmbedding?: number[],
  asOf?: Date | null,
): Promise<RetrievalMatch[]> {
  const fetchK = Math.max(candidateK, topK);
  const embedding = precomputedEmbedding ?? await embedQuery(embeddingQuery || question);
  const [vectorMatches, keywordMatches] = await Promise.all([
    searchSimilarDecisions(tenantId, embedding, fetchK, asOf),
    searchDecisionsKeyword(tenantId, keywordQuery || question, fetchK, asOf),
  ]);
  return fuseRrf(vectorMatches, keywordMatches, fetchK);
}

// ── Permissions: Layer 2 authorization (mirrors modules/permissions) ─────

const SLACK_CHANNEL_RE = /^C[A-Z0-9]{8,}$/;
const NOTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUnmappedScope(scope: string): boolean {
  return SLACK_CHANNEL_RE.test(scope) || NOTION_ID_RE.test(scope);
}

/**
 * Real per-scope membership, loaded once per request from
 * public.source_scope_members (populated by slack-membership-sync).
 *
 * `known` is every scope we have ANY membership data for; `memberOf` is the
 * subset the caller is actually in. The distinction is the whole safety
 * mechanism: a scope we have never synced stays on the old permissive
 * behaviour, so shipping this can't retroactively hide content people are
 * currently, correctly seeing. Coverage tightens as the sync fills in.
 */
type ScopeAccess = { known: Set<string>; memberOf: Set<string> };

const EMPTY_SCOPE_ACCESS: ScopeAccess = { known: new Set(), memberOf: new Set() };

async function loadScopeAccess(
  tenantId: string, email: string | null, scopes: string[],
): Promise<ScopeAccess> {
  const candidates = [...new Set(scopes.filter(isUnmappedScope))];
  if (candidates.length === 0) return EMPTY_SCOPE_ACCESS;

  try {
    const rows = await withTenant(tenantId, async (sql) => {
      return await sql`
        select external_scope_id,
               bool_or(lower(member_email) = lower(${email ?? ""})) as is_member
        from public.source_scope_members
        where tenant_id = ${tenantId}::uuid
          and external_scope_id = any(${candidates}::text[])
        group by external_scope_id
      `;
    });
    const known = new Set<string>();
    const memberOf = new Set<string>();
    for (const row of rows as unknown as { external_scope_id: string; is_member: boolean }[]) {
      known.add(row.external_scope_id);
      if (row.is_member) memberOf.add(row.external_scope_id);
    }
    return { known, memberOf };
  } catch (err) {
    // Fail OPEN on a lookup error rather than locking a tenant out of their
    // own memory because a telemetry-adjacent table is unavailable. The
    // deny path below only ever engages on data we successfully read.
    console.error("scope membership lookup failed, falling back to legacy behaviour:", err);
    return EMPTY_SCOPE_ACCESS;
  }
}

function isDecisionAccessible(
  permissionScopes: string[], decision: RetrievalMatch, access: ScopeAccess,
): boolean {
  if (!decision.permission_scope || decision.permission_scope.length === 0) return true;
  // Workspace-level scopes and the caller's own email, unchanged.
  if (decision.permission_scope.some((s) => permissionScopes.includes(s))) return true;
  // Real membership: the caller is in one of the channels this came from.
  if (decision.permission_scope.some((s) => access.memberOf.has(s))) return true;
  // We have real membership data for at least one of these scopes and the
  // caller is in none of them - this is the case that used to fail open.
  if (decision.permission_scope.some((s) => access.known.has(s))) return false;
  // No membership data for any scope yet: unchanged legacy behaviour.
  return decision.permission_scope.every(isUnmappedScope);
}

function filterAccessibleDecisions(
  permissionScopes: string[], matches: RetrievalMatch[], access: ScopeAccess,
): RetrievalMatch[] {
  return matches.filter((m) => isDecisionAccessible(permissionScopes, m, access));
}

// ── Context builder (mirrors modules/context/formatter.py, byte-for-byte) ─

const DIVIDER = "-".repeat(50);

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function decisionBlockLines(index: number, m: RetrievalMatch): string[] {
  const lines = [
    "", `Decision ${index}`, "", "Decision:", m.decision_statement, "",
    "Reason:", m.rationale ?? "Not provided", "",
    "Alternatives:", m.alternatives_considered.length ? m.alternatives_considered.join(", ") : "None", "",
    "Confidence:", formatConfidence(m.confidence),
  ];
  if (m.owner) lines.push("", "Owner:", m.owner);
  if (m.created_at) lines.push("", "Date:", m.created_at);
  if (m.source) lines.push("", "Source:", m.source);
  if (m.decision_type) lines.push("", "Decision Type:", m.decision_type);
  lines.push("", DIVIDER);
  return lines;
}

function formatContext(decisions: RetrievalMatch[]): string {
  const lines = [DIVIDER];
  decisions.forEach((d, i) => lines.push(...decisionBlockLines(i + 1, d)));
  return lines.join("\n");
}

function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

// ── Claude (forced tool-use; same shape as ai-worker/index.ts's callClaude) ─

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SYNTHESIS_MODEL = Deno.env.get("ANTHROPIC_SYNTHESIS_MODEL") ?? "claude-haiku-4-5-20251001";

async function callClaude(
  system: string, userMessage: string, tool: Record<string, unknown>, toolName: string,
  maxTokens: number, timeoutMs: number,
): Promise<Record<string, unknown>> {
  const resp = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: SYNTHESIS_MODEL, max_tokens: maxTokens, temperature: 0, system,
      messages: [{ role: "user", content: userMessage }],
      tools: [tool], tool_choice: { type: "tool", name: toolName },
    }),
  }, timeoutMs);
  if (!resp.ok) throw new Error(`Anthropic API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const block = (data.content ?? []).find((b: { type?: string }) => b.type === "tool_use");
  if (!block) throw new Error(`Claude did not return a tool_use block for ${toolName}`);
  return block.input as Record<string, unknown>;
}

// ── Query understanding (mirrors modules/query_understanding) ────────────

type QueryAnalysis = {
  intent: string; question_type: string; entities: string[]; keywords: string[];
  department_guess: string; is_multi_document: boolean;
};

const NULL_QUERY_ANALYSIS: QueryAnalysis = {
  intent: "unanalyzed", question_type: "other", entities: [], keywords: [],
  department_guess: "", is_multi_document: false,
};

const QUERY_ANALYSIS_TOOL = {
  name: "record_query_analysis",
  description: "Record a structured analysis of the user's question before retrieval runs.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string" },
      question_type: { type: "string", enum: ["why", "what", "when", "who", "list", "summary", "comparison", "other"] },
      entities: { type: "array", items: { type: "string" } },
      keywords: { type: "array", items: { type: "string" } },
      department_guess: { type: "string" },
      is_multi_document: { type: "boolean" },
    },
    required: ["intent", "question_type", "entities", "keywords", "department_guess", "is_multi_document"],
    additionalProperties: false,
  },
};

const QUERY_ANALYSIS_SYSTEM_PROMPT = `You are the query-understanding stage of Locus AI, a decision-intelligence system. Before any retrieval happens, analyze the user's question so the retrieval layer can find the right decisions.

For the question below, determine:

1. intent - one sentence describing what the user actually wants to know.
2. question_type - the primary form of the question: why, what, when, who, list, summary, comparison, or other. ("list"/"summary"/"comparison" mean the user likely wants MULTIPLE decisions, not just one.)
3. entities - proper nouns, ticket IDs, filenames, people's names, company/vendor names, and acronyms mentioned or clearly implied by the question. Include both the acronym and its likely expansion when relevant (e.g. "SSO" and "Single Sign-On").
4. keywords - 3 to 8 high-signal retrieval terms capturing the core topic. Expand with likely synonyms and related terms a company's internal decision record might actually use - e.g. if the question mentions switching away from a product, include both the old and new product names, the general category, and the type of decision (e.g. "Stripe", "Paddle", "billing", "migration", "payment provider"). Do not include stopwords, question words, or generic verbs like "update" or "decide" unless they are genuinely distinctive to the topic.
5. department_guess - the business domain/department this most likely relates to (e.g. engineering, finance, security, legal, hiring, marketing, product, analytics, customer support, infrastructure), or an empty string if genuinely unclear.
6. is_multi_document - true if answering this well likely requires citing multiple decisions (broad "what have we decided about X" questions, list/summary/comparison questions), false for a question about one specific fact or decision.

Call the record_query_analysis tool exactly once with this analysis. Do not answer the question itself - you have not been given any decisions to answer from yet.`;

async function analyzeQuery(question: string): Promise<QueryAnalysis> {
  try {
    const result = await callClaude(
      QUERY_ANALYSIS_SYSTEM_PROMPT, `Question: ${question}`, QUERY_ANALYSIS_TOOL,
      "record_query_analysis", 512, 15_000,
    );
    return result as unknown as QueryAnalysis;
  } catch (err) {
    console.warn("Query understanding failed, falling back to raw question:", err);
    return NULL_QUERY_ANALYSIS;
  }
}

function keywordSearchQuery(analysis: QueryAnalysis): string {
  return analysis.keywords.join(" OR ");
}

// ── Answering (mirrors modules/answering) ─────────────────────────────────

const REFUSAL_TEXT = "I couldn't find enough information in the available decisions.";

const ANSWER_TOOL = {
  name: "submit_answer",
  description: "Submit the grounded answer to the user's question, based only on the supplied context.",
  input_schema: {
    type: "object",
    properties: {
      sufficient_evidence: { type: "boolean" },
      answer: { type: "string" },
      reasoning: { type: "string" },
      citations: { type: "array", items: { type: "integer" } },
      confidence: { type: "number", minimum: 0.0, maximum: 1.0 },
    },
    required: ["sufficient_evidence", "answer", "reasoning", "citations", "confidence"],
    additionalProperties: false,
  },
};

const FORMATTING_RULES = `- Plain prose only: never use markdown syntax (no **bold**, no # headings, no bullet or numbered list characters). The frontend displays this text as-is, so any markdown punctuation shows up literally to the reader instead of being rendered. Structure with plain sentences and paragraph breaks instead.
- Never use an em dash (—) or double hyphen (--). Use a period, comma, colon, or "and"/"but" to join or separate clauses instead.`;

const MULTI_DOCUMENT_INSTRUCTION = `This question likely spans multiple decisions. If more than one decision in the context is relevant, structure your answer as a short list in plain text - one sentence per relevant decision, each citing its decision number, with a blank line (an actual newline in your answer text) between each one - followed by a one-sentence overall summary on its own line at the end. Do not merge distinct decisions into one statement if they are actually separate, and do not run every item together into a single unbroken paragraph.`;

function buildSystemPrompt(analysis: QueryAnalysis | null): string {
  const instruction = analysis && analysis !== NULL_QUERY_ANALYSIS && analysis.is_multi_document ? MULTI_DOCUMENT_INSTRUCTION : "";
  return `You are Locus AI, answering questions about a company's recorded decisions using ONLY the context supplied below.

Rules:
- The input is not always phrased as a question. If it is a bare topic, name, or keyword (e.g. "billing" or "Marcus Webb") rather than a question, treat it as an implicit "what do we know about this", using the same context and citation rules below, rather than refusing for lack of a literal question mark.
- Answer ONLY using the supplied context. Never use outside knowledge, general assumptions, or anything about what a company "probably" did.
- Never invent facts, decisions, owners, dates, or outcomes that are not explicitly present in the context.
- Cite every factual statement you make with its specific decision number (e.g. "Decision 2"). A sentence with no citation should not contain a specific claim from the context.
- If one or more decisions in the context directly and clearly support an answer, answer confidently and cite them - even if other, less relevant decisions are also present in the context. The presence of topically-related-but-non-answering decisions is NOT a reason to refuse or hedge; only evaluate whether the decisions that actually bear on the question support an answer.
- Only when two or more decisions DIRECTLY conflict about the same specific fact (not merely adjacent or topically similar) should you explain both viewpoints instead of silently picking one.
- Set sufficient_evidence to false ONLY when no decision in the context actually answers the question. Do not refuse merely because multiple related decisions exist, but do not guess or partially answer from outside knowledge when the context genuinely lacks a supporting decision.
${FORMATTING_RULES}
${instruction}
Call the submit_answer tool exactly once with your response.`;
}

function buildUserMessage(question: string, context: string, analysis: QueryAnalysis | null): string {
  let header = `Question:\n${question}`;
  if (analysis && analysis !== NULL_QUERY_ANALYSIS && analysis.intent) {
    header += `\n\nDetected intent: ${analysis.intent} (question_type=${analysis.question_type})`;
  }
  return `${header}\n\nContext:\n${context}`;
}

type AnswerResult = { answer: string; reasoning: string; citations: number[]; confidence: number; model: string };

async function generateAnswer(question: string, context: string, analysis: QueryAnalysis | null = null): Promise<AnswerResult> {
  const systemPrompt = buildSystemPrompt(analysis);
  const userMessage = buildUserMessage(question, context, analysis);
  const toolOutput = await callClaude(systemPrompt, userMessage, ANSWER_TOOL, "submit_answer", 1024, 30_000) as {
    sufficient_evidence: boolean; answer: string; reasoning: string; citations: number[]; confidence: number;
  };

  if (toolOutput.sufficient_evidence) {
    return {
      answer: toolOutput.answer, reasoning: toolOutput.reasoning,
      citations: [...new Set(toolOutput.citations)].sort((a, b) => a - b),
      confidence: toolOutput.confidence, model: SYNTHESIS_MODEL,
    };
  }
  return { answer: REFUSAL_TEXT, reasoning: toolOutput.reasoning, citations: [], confidence: toolOutput.confidence, model: SYNTHESIS_MODEL };
}

/**
 * Pulls the current value of a string field out of JSON that is still being
 * written.
 *
 * Needed because the answer arrives as a forced tool call, so Claude streams
 * the tool's *arguments* as `input_json_delta` fragments rather than plain
 * text. Mid-stream the buffer looks like:
 *
 *   {"sufficient_evidence": true, "answer": "On June 18 the team stand
 *
 * JSON.parse can't touch that, but the answer text is sitting right there.
 * This walks the buffer and decodes escapes as it goes, stopping cleanly at
 * a half-written escape sequence rather than emitting a broken character.
 */
function extractPartialString(buffer: string, key: string): string | null {
  const marker = `"${key}"`;
  const keyIdx = buffer.indexOf(marker);
  if (keyIdx === -1) return null;

  let i = keyIdx + marker.length;
  while (i < buffer.length && buffer[i] !== ":") i++;
  i++;
  while (i < buffer.length && /\s/.test(buffer[i])) i++;
  if (buffer[i] !== '"') return null;
  i++;

  let out = "";
  while (i < buffer.length) {
    const ch = buffer[i];
    if (ch === "\\") {
      const next = buffer[i + 1];
      if (next === undefined) break; // escape split across chunks - wait for more
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === "u") {
        const hex = buffer.slice(i + 2, i + 6);
        if (hex.length < 4) break; // partial unicode escape
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      } else out += next; // covers escaped quote, backslash, anything else
      i += 2;
      continue;
    }
    if (ch === '"') break; // closing quote - field is complete
    out += ch;
    i++;
  }
  return out;
}

/**
 * Same call and same forced tool as generateAnswer, but streamed: onDelta
 * receives each newly-written slice of the answer as Claude produces it.
 *
 * Total time is unchanged - this only stops the user staring at nothing for
 * the ~4.9s the synthesis call measured. The structured result (citations,
 * confidence, refusal handling) is still parsed from the completed JSON at
 * the end, so the final payload is identical to the non-streaming path.
 */
async function generateAnswerStreaming(
  question: string,
  context: string,
  analysis: QueryAnalysis | null,
  onDelta: (chunk: string) => void,
): Promise<AnswerResult> {
  const systemPrompt = buildSystemPrompt(analysis);
  const userMessage = buildUserMessage(question, context, analysis);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: SYNTHESIS_MODEL, max_tokens: 1024, temperature: 0, system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools: [ANSWER_TOOL], tool_choice: { type: "tool", name: "submit_answer" },
      stream: true,
    }),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`Anthropic API error ${resp.status}: ${await resp.text()}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let jsonBuffer = "";
  let emitted = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });

    // SSE frames are newline-delimited; a frame can straddle two chunks, so
    // only whole lines are consumed and the remainder is kept.
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === "content_block_delta" && evt.delta?.type === "input_json_delta") {
          jsonBuffer += evt.delta.partial_json ?? "";
          const soFar = extractPartialString(jsonBuffer, "answer");
          if (soFar !== null && soFar.length > emitted.length) {
            onDelta(soFar.slice(emitted.length));
            emitted = soFar;
          }
        }
      } catch {
        // A malformed frame is skipped rather than aborting the stream -
        // the completed JSON below is still the source of truth.
      }
    }
  }

  let parsed: {
    sufficient_evidence?: boolean; answer?: string; reasoning?: string;
    citations?: number[]; confidence?: number;
  };
  try {
    parsed = JSON.parse(jsonBuffer);
  } catch {
    throw new Error("Claude's streamed answer did not parse as valid JSON");
  }

  if (parsed.sufficient_evidence) {
    return {
      answer: parsed.answer ?? "",
      reasoning: parsed.reasoning ?? "",
      citations: [...new Set(parsed.citations ?? [])].sort((a, b) => a - b),
      confidence: parsed.confidence ?? 0,
      model: SYNTHESIS_MODEL,
    };
  }
  return {
    answer: REFUSAL_TEXT, reasoning: parsed.reasoning ?? "",
    citations: [], confidence: parsed.confidence ?? 0, model: SYNTHESIS_MODEL,
  };
}

function buildCitations(citationNumbers: number[], authorized: RetrievalMatch[]) {
  const citations = [];
  for (const number of citationNumbers) {
    if (number >= 1 && number <= authorized.length) {
      const match = authorized[number - 1];
      citations.push({
        decision_number: number, decision_id: match.decision_id,
        decision_statement: match.decision_statement, confidence: match.confidence,
      });
    }
  }
  return citations;
}

// ── Handler: POST /search ──────────────────────────────────────────────

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 50;
const DEFAULT_CANDIDATE_K = 20;
const MULTI_DOCUMENT_MIN_TOP_K = 10;
const RERANK_MIN_TOP_K = 7;

async function handleSearch(req: Request): Promise<Response> {
  let ctx: TenantContext;
  try {
    ctx = await getCurrentTenant(req);
  } catch (err) {
    return errorResponse(401, err instanceof Error ? err.message : "Unauthorized");
  }

  try {
    await enforceRouteRateLimit(ctx.tenantId, "search");
    await enforceUserPromptLimit(ctx.userId);
  } catch (err) {
    if (err instanceof RouteRateLimitExceededError) return routeRateLimitResponse(err);
    if (err instanceof PromptLimitExceededError) return promptLimitResponse(err);
    console.error("prompt limit check failed:", err);
    return errorResponse(500, "Failed to enforce prompt limit");
  }

  let body: { question?: string; top_k?: number; stream?: boolean; as_of?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  const question = (body.question ?? "").trim();
  if (!question) return errorResponse(422, "question is required");
  const wantsStream = body.stream === true;
  const requestedTopK = Math.min(Math.max(body.top_k ?? DEFAULT_TOP_K, 1), MAX_TOP_K);

  const searchStartedAt = Date.now();
  const trace = new Trace();

  // Point-in-time search: {"as_of": "2026-09-01"} answers from the memory as
  // it stood then, superseded entries included, rather than today's.
  //
  // Parsed up here, before any work, specifically so a malformed value is
  // still a clean 400. Once the stream below is open the status line has
  // already been sent and the only way left to report a bad request is an
  // error frame, which is a worse answer to "you typed the date wrong".
  let searchAsOf: Date | null = null;
  try {
    searchAsOf = parseAsOf(typeof body.as_of === "string" ? body.as_of : null);
  } catch {
    return errorResponse(400, "as_of must be an ISO 8601 date or timestamp");
  }

  /**
   * Reports a finished pipeline stage. A no-op on the non-streaming path.
   *
   * Exists because the median search spends 2.3s in analyze_and_embed before
   * the first byte of the answer exists, and the browser had no way to know
   * anything was happening during it - measured from request_traces, not
   * guessed. The counts are passed through so the UI can show what each stage
   * actually did rather than an indeterminate spinner.
   */
  type StageReport = (name: string, detail: Record<string, unknown>) => void;

  /**
   * Everything up to answer generation.
   *
   * Extracted verbatim so both paths run the same code: the streaming branch
   * needs it INSIDE the response stream (so stages can be reported as they
   * complete), the JSON branch needs it before building the body, and the one
   * thing worse than this indirection would be two copies drifting apart.
   */
  const runRetrieval = async (onStage: StageReport) => {
    const { scopes: permissionScopes, email } = await resolvePermissionScopes(ctx.userId, ctx.tenantId);
    trace.mark("resolve_scopes");
    onStage("resolve_scopes", { scopes: permissionScopes.length });

    // analyzeQuery and embedQuery are independent: embedQuery only needs the
    // raw question text, not analyzeQuery's output (only the keyword-search
    // half of hybridRetrieve needs analysis.keywords). Previously these ran
    // sequentially - analyzeQuery's full Claude round trip finished before
    // the Voyage embedding call even started - for no real reason. Running
    // them concurrently removes one full LLM-call's worth of latency from
    // every /search request at zero extra cost (same calls, same tokens).
    const [analysis, precomputedEmbedding] = await Promise.all([
      analyzeQuery(question),
      embedQuery(question),
    ]);
    trace.mark("analyze_and_embed");
    onStage("analyze_and_embed", {
      question_type: analysis.question_type,
      is_multi_document: analysis.is_multi_document,
    });

    let effectiveTopK = Math.max(requestedTopK, RERANK_MIN_TOP_K);
    if (analysis.is_multi_document) {
      effectiveTopK = Math.min(MAX_TOP_K, Math.max(effectiveTopK, MULTI_DOCUMENT_MIN_TOP_K));
    }
    const candidateK = Math.max(DEFAULT_CANDIDATE_K, effectiveTopK * 2);

    const candidates = await hybridRetrieve(
      ctx.tenantId, question, effectiveTopK, candidateK, question, keywordSearchQuery(analysis),
      precomputedEmbedding, searchAsOf,
    );
    trace.mark("retrieve");
    onStage("retrieve", { candidates: candidates.length });

    const scopeAccess = await loadScopeAccess(
      ctx.tenantId, email, candidates.flatMap((c) => c.permission_scope ?? []),
    );
    const authorized = filterAccessibleDecisions(permissionScopes, candidates, scopeAccess);
    trace.mark("authorize");
    onStage("authorize", {
      authorized: authorized.length,
      withheld: Math.max(0, candidates.length - authorized.length),
    });

    // No cross-encoder here (see file header) - truncate to effectiveTopK directly,
    // reproducing that module's own fail-open fallback path exactly.
    const finalMatches = authorized.slice(0, effectiveTopK);
    const context = formatContext(finalMatches);

    return { analysis, candidates, authorized, finalMatches, context };
  };

  try {
    // Streaming path. Same retrieval, same model, same forced tool - the
    // only difference is that the answer reaches the browser as it is
    // written instead of after the full ~4.9s synthesis call. Opt-in via
    // {stream: true} so the existing non-streaming contract keeps working
    // untouched for the MCP server and any other caller.
    //
    // The response opens BEFORE retrieval now, not after. That is what lets
    // the 2.3s of query analysis and embedding be visible to the caller
    // instead of silent.
    if (wantsStream) {
      const encoder = new TextEncoder();
      const sse = new ReadableStream({
        async start(controller) {
          const send = (event: string, data: unknown) => {
            controller.enqueue(encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ));
          };
          try {
            const { analysis, candidates, authorized, finalMatches, context } = await runRetrieval(
              (name, detail) => send("stage", {
                name,
                elapsed_ms: Date.now() - searchStartedAt,
                ...detail,
              }),
            );

            send("stage", {
              name: "generate_answer",
              status: "started",
              elapsed_ms: Date.now() - searchStartedAt,
              decisions: finalMatches.length,
            });

            const answerResult = await generateAnswerStreaming(
              question, context, analysis, (chunk) => send("delta", { text: chunk }),
            );
            trace.mark("generate_answer");
            trace.flag("streamed");

            send("done", {
              answer: answerResult.answer,
              citations: buildCitations(answerResult.citations, finalMatches),
              reasoning: answerResult.reasoning,
              confidence: answerResult.confidence,
              metadata: {
                model: answerResult.model,
                latency_ms: Date.now() - searchStartedAt,
                stage_ms: trace.stages,
                retrieved_count: candidates.length,
                authorized_count: authorized.length,
                decision_count: finalMatches.length,
                token_estimate: estimateTokens(context),
                question_type: analysis.question_type,
                is_multi_document: analysis.is_multi_document,
                reranked: false,
                recency_reranked: true,
                streamed: true,
              },
            });
            void trace.write(ctx.tenantId, "POST /search");
          } catch (err) {
            const message = err instanceof Error ? err.message : "Search failed";
            console.error("streaming search failed:", err);
            send("error", { error: message });
            void trace.write(ctx.tenantId, "POST /search", { ok: false, error: message });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(sse, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    const { analysis, candidates, authorized, finalMatches, context } = await runRetrieval(() => {});

    const answerResult = await generateAnswer(question, context, analysis);
    const citations = buildCitations(answerResult.citations, finalMatches);
    trace.mark("generate_answer");

    // Not awaited: a telemetry insert must never sit between the answer
    // being ready and the caller receiving it.
    void trace.write(ctx.tenantId, "POST /search");

    return jsonResponse({
      answer: answerResult.answer,
      citations,
      reasoning: answerResult.reasoning,
      confidence: answerResult.confidence,
      metadata: {
        model: answerResult.model,
        latency_ms: Date.now() - searchStartedAt,
        stage_ms: trace.stages,
        retrieved_count: candidates.length,
        authorized_count: authorized.length,
        decision_count: finalMatches.length,
        token_estimate: estimateTokens(context),
        question_type: analysis.question_type,
        is_multi_document: analysis.is_multi_document,
        reranked: false,
        // Separate from `reranked` (the cross-encoder pass, still skipped -
        // see file header) - this is the RRF-stage recency blend in
        // fuseRrf, which does run.
        recency_reranked: true,
      },
    });
  } catch (err) {
    console.error("search failed:", err);
    const message = err instanceof Error ? err.message : "Search failed";
    // Failures are the half of the data that matters most - a trace table
    // that only records successes hides exactly the requests worth finding.
    void trace.write(ctx.tenantId, "POST /search", { ok: false, error: message });
    return errorResponse(502, message);
  }
}

// ── Handler: GET /digest ──────────────────────────────────────────────

const DIGEST_TOP_K = 25;
const TEAM_QUESTION = "What were the most important decisions made by the team this week? Summarize them clearly, grouped by theme if helpful.";

// Specialized friendly digest prompt for weekly summaries
const DIGEST_SYSTEM_PROMPT = `You are Locus AI, creating a friendly, concise weekly digest for a team.

Your goal is to transform raw decision data into an engaging, easy-to-read summary that feels like a helpful team update.

Style guidelines:
- Write in a warm, conversational tone - like a helpful colleague sharing a quick update
- Keep it concise: 2-4 short paragraphs maximum
- Separate each paragraph with a blank line (an actual newline in your answer text) - never run paragraphs together into one unbroken block
- Do not open a paragraph with a bare topic label like "Infrastructure and Deployment" or "Team and Meetings" - write flowing sentences instead, the topic should be clear from the content itself
- Focus on the "so what?" - why these decisions matter to the team
- Use simple, clear language that anyone can understand
- Group related decisions naturally without forced categories
- Avoid jargon, technical details, and formal business language
- Never use markdown formatting - plain text only
- End with an encouraging, forward-looking sentence when appropriate

Content guidelines:
- Highlight the most impactful decisions first
- Mention themes or patterns you notice (e.g., "The team focused heavily on...")
- Skip minor decisions that don't affect the bigger picture
- If there are conflicting decisions, acknowledge them simply
- When in doubt, simpler is better

Remember: This is meant to be a quick, helpful read that gives the team a sense of what happened and why it matters.`;

function personalQuestion(actorName: string): string {
  return `Summarize the key decisions ${actorName} was involved in or that affected their work over the past 7 days. Group by theme if helpful.`;
}

async function resolveCallerActor(tenantId: string, userId: string): Promise<string | null> {
  return await withTenant(tenantId, async (sql) => {
    const rows = await sql`
      SELECT display_name, email FROM actors WHERE tenant_id = ${tenantId} AND auth_user_id = ${userId}
    `;
    if (rows.length === 0) return null;
    return rows[0].display_name || rows[0].email || null;
  });
}

function digestWeekOf(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday));
  if (diffToMonday === 0 && now.getUTCHours() < 9) {
    monday.setUTCDate(monday.getUTCDate() - 7);
  }
  return monday.toISOString().slice(0, 10);
}

// Specialized digest summary generation using friendly prompt
async function generateDigestSummary(question: string, context: string): Promise<string> {
  const userMessage = `${question}\n\nContext:\n${context}`;
  const result = await callClaude(DIGEST_SYSTEM_PROMPT, userMessage, ANSWER_TOOL, "submit_answer", 512, 30_000) as {
    sufficient_evidence: boolean; answer: string; reasoning: string; citations: number[]; confidence: number;
  };
  
  // For digests, we always return the answer regardless of sufficient_evidence
  // since we want to provide the best summary possible even if not all context is available
  return result.answer;
}

// Snaps an arbitrary requested date to its own ISO week's Monday - used for
// looking up an already-cached historical digest by whatever week the
// frontend's date picker landed on, distinct from digestWeekOf()'s "now"
// (which also has a just-past-midnight-Monday grace period that only makes
// sense for the live current week, not an explicit past-week lookup).
function mondayOfDate(d: Date): string {
  const day = d.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMonday));
  return monday.toISOString().slice(0, 10);
}

function periodBoundsForWeek(weekOf: string): { start: string; end: string } {
  const end = new Date(weekOf + "T00:00:00Z");
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function loadWeeklyDigest(tenantId: string, scope: "personal" | "team", weekOf: string, userId: string | null) {
  if (scope === "personal" && !userId) return null;
  return await withTenant(tenantId, async (sql) => {
    const rows = scope === "team"
      ? await sql`
          SELECT scope, period_start, period_end, summary, items, metadata
          FROM weekly_digests WHERE tenant_id = ${tenantId} AND scope = 'team' AND week_of = ${weekOf}
        `
      : await sql`
          SELECT scope, period_start, period_end, summary, items, metadata
          FROM weekly_digests WHERE tenant_id = ${tenantId} AND scope = 'personal'
            AND user_id = ${userId} AND week_of = ${weekOf}
        `;
    const row = rows[0];
    if (!row) return null;
    return {
      scope: row.scope, period: `${row.period_start}/${row.period_end}`,
      summary: row.summary, items: row.items, metadata: row.metadata,
    };
  });
}

// deno-lint-ignore no-explicit-any
async function saveWeeklyDigest(tenantId: string, digest: any, weekOf: string, userId: string | null) {
  const { start, end } = periodBoundsForWeek(weekOf);
  const [periodStart, periodEnd] = digest.period.split("/");
  await withTenant(tenantId, async (sql) => {
    if (digest.scope === "team") {
      await sql`
        INSERT INTO weekly_digests (tenant_id, user_id, scope, week_of, period_start, period_end, summary, items, metadata)
        VALUES (${tenantId}, NULL, 'team', ${weekOf}, ${periodStart ?? start}, ${periodEnd ?? end}, ${digest.summary}, ${sql.json(digest.items)}::jsonb, ${sql.json(digest.metadata)}::jsonb)
        ON CONFLICT (tenant_id, week_of) WHERE (scope = 'team')
        DO UPDATE SET period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
          summary = EXCLUDED.summary, items = EXCLUDED.items, metadata = EXCLUDED.metadata, created_at = now()
      `;
    } else {
      await sql`
        INSERT INTO weekly_digests (tenant_id, user_id, scope, week_of, period_start, period_end, summary, items, metadata)
        VALUES (${tenantId}, ${userId}, 'personal', ${weekOf}, ${periodStart ?? start}, ${periodEnd ?? end}, ${digest.summary}, ${sql.json(digest.items)}::jsonb, ${sql.json(digest.metadata)}::jsonb)
        ON CONFLICT (tenant_id, user_id, week_of) WHERE (scope = 'personal')
        DO UPDATE SET period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
          summary = EXCLUDED.summary, items = EXCLUDED.items, metadata = EXCLUDED.metadata, created_at = now()
      `;
    }
  });
}

async function generateTeamPulse(tenantId: string, permissionScopes: string[], callerEmail: string | null, scope: "personal" | "team", userId: string | null) {
  let personalized = true;
  let question = TEAM_QUESTION;
  if (scope === "personal") {
    const actorName = userId ? await resolveCallerActor(tenantId, userId) : null;
    if (actorName) {
      question = personalQuestion(actorName);
    } else {
      personalized = false;
    }
  }

  const matches = await hybridRetrieve(tenantId, question, DIGEST_TOP_K, DIGEST_TOP_K, question, question);
  const digestScopeAccess = await loadScopeAccess(
    tenantId, callerEmail, matches.flatMap((m) => m.permission_scope ?? []),
  );
  const authorized = filterAccessibleDecisions(permissionScopes, matches, digestScopeAccess);
  const context = formatContext(authorized);
  
  // Use specialized friendly digest summary generation
  const summary = await generateDigestSummary(question, context);

  const items = authorized.map((m) => ({
    decision_statement: m.decision_statement, rationale: m.rationale,
    confidence: m.confidence, created_at: m.created_at,
    // record_type wasn't on digest items before - TeamPulse.tsx needs it to
    // bucket into its Decisions/Action items/Blockers sections the same way
    // it already does for listAllDecisions() results.
    record_type: m.decision_type,
  }));

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const period = `${weekAgo.toISOString().slice(0, 10)}/${now.toISOString().slice(0, 10)}`;

  return {
    scope, period, summary, items,
    metadata: {
      model: SYNTHESIS_MODEL, latency_ms: 0, decision_count: authorized.length,
      token_estimate: estimateTokens(context), personalized,
    },
  };
}

async function handleDigest(req: Request, url: URL): Promise<Response> {
  let ctx: TenantContext;
  try {
    ctx = await getCurrentTenant(req);
  } catch (err) {
    return errorResponse(401, err instanceof Error ? err.message : "Unauthorized");
  }

  const scope = (url.searchParams.get("scope") ?? "personal") as "personal" | "team";
  const refresh = url.searchParams.get("refresh") === "true";
  if (scope !== "personal" && scope !== "team") return errorResponse(422, "scope must be 'personal' or 'team'");

  const currentWeekOf = digestWeekOf();
  const weekOfParam = url.searchParams.get("week_of");
  let requestedWeekOf = currentWeekOf;
  if (weekOfParam) {
    const parsed = new Date(`${weekOfParam}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) requestedWeekOf = mondayOfDate(parsed);
  }
  const isCurrentWeek = requestedWeekOf === currentWeekOf;

  try {
    // A team digest is cached per (tenant, week) and served to every member,
    // so it must be built only from content every member can see. Resolving
    // scopes with personal sources excluded is what makes that true; without
    // it the first person to open Team Pulse baked their own Gmail into a
    // tenant-wide artefact. The personal digest is unaffected - it is cached
    // per user and only ever returned to that user.
    const { scopes: permissionScopes, email: callerEmail } = await resolvePermissionScopes(
      ctx.userId,
      ctx.tenantId,
      { excludePersonalSources: scope === "team" },
    );
    const userId = scope === "personal" ? ctx.userId : null;

    // A non-current week can only ever be served from what's already
    // cached - retrieval isn't date-filtered, so "generating" one now would
    // just re-summarize whatever's currently semantically top-ranked and
    // mislabel it with a past date range instead of reflecting what that
    // week actually was. Once a week has been generated while it WAS the
    // current week, it stays available here indefinitely; a week nobody
    // opened Team Pulse during never got cached and has nothing to show.
    if (!isCurrentWeek) {
      const stored = await loadWeeklyDigest(ctx.tenantId, scope, requestedWeekOf, userId);
      if (stored) return jsonResponse(stored);
      return errorResponse(404, "No digest available for this week");
    }

    if (!refresh) {
      const stored = await loadWeeklyDigest(ctx.tenantId, scope, requestedWeekOf, userId);
      if (stored) return jsonResponse(stored);
    }

    // Only gated here, not at the top of the handler like /search - a
    // cache hit above never calls Claude, so it shouldn't cost a prompt
    // or count against either limiter.
    await enforceRouteRateLimit(ctx.tenantId, "digest");
    await enforceUserPromptLimit(ctx.userId);
    const digest = await generateTeamPulse(ctx.tenantId, permissionScopes, callerEmail, scope, userId);
    try {
      await saveWeeklyDigest(ctx.tenantId, digest, requestedWeekOf, userId);
    } catch (err) {
      console.error("Failed to persist digest:", err);
    }
    return jsonResponse(digest);
  } catch (err) {
    if (err instanceof RouteRateLimitExceededError) return routeRateLimitResponse(err);
    if (err instanceof PromptLimitExceededError) return promptLimitResponse(err);
    console.error("digest failed:", err);
    return errorResponse(502, err instanceof Error ? err.message : "Digest generation failed");
  }
}

// ── Handler: GET /attention ────────────────────────────────────────────
//
// Rebuilt for the decisions pipeline after the memory-intelligence layer
// (which the old Attention Strip read from) was removed entirely -
// deliberately the smallest useful version: unresolved conflicts only,
// nothing else. Pure SQL read of decision_conflicts, a table the existing
// pipeline already populates during normal ingestion (see ai-worker's
// conflict-detection call) - this endpoint makes zero Claude API calls of
// its own, $0 marginal cost per request, no matter how often the
// dashboard polls it.
//
// decision_conflicts only ever stores 'contradicts' pairs - 'duplicates'
// auto-resolves via decisions.superseded_by and never reaches this table
// (see ai-worker/index.ts's own comment on that split), so every row here
// is already exactly "needs a human to look at it," no relationship
// filter needed.

interface AttentionConflictItem {
  id: string;
  decision_id: string;
  decision_statement: string;
  related_decision_id: string;
  related_decision_statement: string;
  reason: string;
  confidence: number;
  created_at: string;
}

const ATTENTION_STRIP_LIMIT = 4;
// Pulled wider than the strip actually shows so permission filtering
// (below) has real rows left to filter from - matching the same
// over-fetch-then-filter shape the rest of this file already uses for
// retrieval (see hybridSearch's fetchK vs top_k).
const ATTENTION_CANDIDATE_LIMIT = 20;

async function handleAttention(req: Request): Promise<Response> {
  let ctx: TenantContext;
  try {
    ctx = await getCurrentTenant(req);
  } catch (err) {
    return errorResponse(401, err instanceof Error ? err.message : "Unauthorized");
  }

  try {
    const { scopes: permissionScopes, email: attentionEmail } = await resolvePermissionScopes(ctx.userId, ctx.tenantId);

    const rows = await withTenant(ctx.tenantId, (sql) =>
      sql`
        SELECT
          dc.id, dc.reason, dc.confidence, dc.created_at,
          d1.id AS decision_id, d1.decision_statement AS decision_statement, d1.permission_scope AS decision_permission_scope,
          d2.id AS related_decision_id, d2.decision_statement AS related_decision_statement, d2.permission_scope AS related_permission_scope
        FROM public.decision_conflicts dc
        JOIN public.decisions d1 ON d1.id = dc.decision_id AND d1.tenant_id = dc.tenant_id
        JOIN public.decisions d2 ON d2.id = dc.related_decision_id AND d2.tenant_id = dc.tenant_id
        WHERE dc.tenant_id = ${ctx.tenantId}
        ORDER BY dc.created_at DESC
        LIMIT ${ATTENTION_CANDIDATE_LIMIT}
      `
    );

    // A conflict is attention-worthy for this viewer only if they could
    // see BOTH decisions it's between - showing "X conflicts with Y" when
    // the viewer can't even see what Y is would leak its existence.
    const conflictRows = rows as unknown as {
      id: string; reason: string; confidence: number; created_at: string;
      decision_id: string; decision_statement: string; decision_permission_scope: string[] | null;
      related_decision_id: string; related_decision_statement: string; related_permission_scope: string[] | null;
    }[];

    const attentionAccess = await loadScopeAccess(
      ctx.tenantId, attentionEmail,
      conflictRows.flatMap((r) => [...(r.decision_permission_scope ?? []), ...(r.related_permission_scope ?? [])]),
    );

    const accessible = conflictRows.filter((r) =>
      isDecisionAccessible(permissionScopes, { permission_scope: r.decision_permission_scope ?? [] } as RetrievalMatch, attentionAccess) &&
      isDecisionAccessible(permissionScopes, { permission_scope: r.related_permission_scope ?? [] } as RetrievalMatch, attentionAccess)
    );

    const items: AttentionConflictItem[] = accessible.slice(0, ATTENTION_STRIP_LIMIT).map((r) => ({
      id: r.id,
      decision_id: r.decision_id,
      decision_statement: r.decision_statement,
      related_decision_id: r.related_decision_id,
      related_decision_statement: r.related_decision_statement,
      reason: r.reason,
      confidence: r.confidence,
      created_at: r.created_at,
    }));

    return jsonResponse({ items, total: accessible.length });
  } catch (err) {
    console.error("attention failed:", err);
    return errorResponse(500, "Failed to load attention items");
  }
}

// ── Handler: POST /billing/checkout (Stripe REST API, no SDK needed) ─────

async function createCheckoutSession(tenantId: string, plan: string): Promise<{ checkout_url: string; session_id: string }> {
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured");

  const priceMap: Record<string, string | undefined> = {
    self_serve: Deno.env.get("STRIPE_SELF_SERVE_PRICE_ID"),
    team: Deno.env.get("STRIPE_TEAM_PRICE_ID"),
  };
  const priceId = priceMap[plan];
  if (!priceId) throw new Error(`Unknown plan: ${plan}`);

  const successUrl = (Deno.env.get("STRIPE_SUCCESS_URL") ?? "http://localhost:5173/billing/success") + "?session_id={CHECKOUT_SESSION_ID}";
  const cancelUrl = Deno.env.get("STRIPE_CANCEL_URL") ?? "http://localhost:5173/billing/cancel";

  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("client_reference_id", tenantId);
  form.set("metadata[tenant_id]", tenantId);
  form.set("metadata[plan]", plan);
  form.set("subscription_data[metadata][tenant_id]", tenantId);
  form.set("subscription_data[metadata][plan]", plan);
  form.set("success_url", successUrl);
  form.set("cancel_url", cancelUrl);

  const resp = await fetchWithTimeout("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  }, 15_000);
  if (!resp.ok) throw new Error(`Stripe error: ${await resp.text()}`);
  const session = await resp.json();
  return { checkout_url: session.url, session_id: session.id };
}

async function handleBillingCheckout(req: Request): Promise<Response> {
  let ctx: TenantContext;
  try {
    ctx = await getCurrentTenant(req);
  } catch (err) {
    return errorResponse(401, err instanceof Error ? err.message : "Unauthorized");
  }
  let body: { plan?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  if (!body.plan) return errorResponse(400, "plan is required");

  try {
    const result = await createCheckoutSession(ctx.tenantId, body.plan);
    return jsonResponse({ checkout_url: result.checkout_url, session_id: result.session_id });
  } catch (err) {
    console.error("Checkout failed:", err);
    return errorResponse(502, err instanceof Error ? err.message : "Checkout failed");
  }
}

// ── Handler: GET/POST /api/v1/decisions ──────────────────────────────────

async function handleDecisions(req: Request, url: URL): Promise<Response> {
  let ctx: TenantContext;
  try {
    ctx = await getCurrentTenant(req);
  } catch (err) {
    return errorResponse(401, err instanceof Error ? err.message : "Unauthorized");
  }

  const parts = url.pathname.split("/api/v1/decisions")[1]?.split("/").filter(Boolean) ?? [];

  // Real bug found live: Memory Explorer's Source filter buttons (Slack/
  // Gmail/Notion) were a hardcoded frontend array, never checked against
  // real connection state or real data - disconnecting a source and
  // deleting its history left the button sitting there clickable
  // regardless, since nothing about it was ever wired to reality. This
  // returns only sources with an actual, currently-real decision behind
  // them (same "only show what's real" rule Memory Timeline's picker
  // already follows for its own Source filter).
  if (req.method === "GET" && parts.length === 1 && parts[0] === "sources") {
    try {
      const sources = await withTenant(ctx.tenantId, async (sql) => {
        const rows = await sql`
          SELECT DISTINCT re.source
          FROM decisions d
          JOIN raw_events re ON re.id = d.origin_raw_event_id AND re.tenant_id = d.tenant_id
          WHERE d.tenant_id = ${ctx.tenantId} AND d.superseded_by IS NULL AND re.source IS NOT NULL
        `;
        return rows.map((r) => r.source as string).sort();
      });
      return jsonResponse({ sources });
    } catch (err) {
      console.error("list decision sources failed:", err);
      return errorResponse(500, "Failed to list decision sources");
    }
  }

  if (req.method === "GET" && parts.length === 0) {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    const recordType = url.searchParams.get("record_type");
    const source = url.searchParams.get("source");
    // Point-in-time reconstruction: ?as_of=2026-09-01 returns the memory as
    // it stood then. Rejected rather than silently ignored when unparseable,
    // since quietly returning today's answer to a historical question is
    // worse than an error.
    const asOfRaw = url.searchParams.get("as_of");
    try {
      parseAsOf(asOfRaw);
    } catch {
      return errorResponse(400, "as_of must be an ISO 8601 date or timestamp");
    }
    // Traced because Memory Explorer / Decision Log were reported slow with
    // nothing measuring them - this separates the list query itself from the
    // token exchange that runs in front of it on a cold page load.
    const listTrace = new Trace();
    try {
      const result = await listDecisions(ctx.tenantId, ctx.userId, limit, offset, recordType, source, asOfRaw);
      listTrace.mark("list_decisions");
      void listTrace.write(ctx.tenantId, "GET /decisions");
      return jsonResponse(result);
    } catch (err) {
      console.error("list decisions failed:", err);
      listTrace.mark("list_decisions");
      void listTrace.write(ctx.tenantId, "GET /decisions", {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(500, "Failed to list decisions");
    }
  }

  if (req.method === "GET" && parts.length === 1) {
    // Traced like /search: this is the "click a citation to see the source"
    // path, and it was reported as slow with no way to see where the time
    // went. getDecisionById runs several queries plus a possible live Slack
    // name lookup, so the breakdown matters.
    const detailTrace = new Trace();
    try {
      const decision = await getDecisionById(ctx.tenantId, ctx.userId, parts[0]);
      detailTrace.mark("load_decision");
      if (!decision) return errorResponse(404, "Decision not found");
      void detailTrace.write(ctx.tenantId, "GET /decisions/:id");
      return jsonResponse(decision);
    } catch (err) {
      console.error("get decision failed:", err);
      const message = err instanceof Error ? err.message : "Failed to fetch decision";
      void detailTrace.write(ctx.tenantId, "GET /decisions/:id", { ok: false, error: message });
      return errorResponse(500, "Failed to fetch decision");
    }
  }

  return errorResponse(404, "Not found");
}

// ── Entrypoint ─────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname;

  try {
    if (path.endsWith("/auth/session") && req.method === "POST") return await handleAuthSession(req);
    if (path.includes("/api/v1/decisions")) return await handleDecisions(req, url);
    if (path.endsWith("/search") && req.method === "POST") return await handleSearch(req);
    if (path.endsWith("/digest") && req.method === "GET") return await handleDigest(req, url);
    if (path.endsWith("/attention") && req.method === "GET") return await handleAttention(req);
    if (path.endsWith("/billing/checkout") && req.method === "POST") return await handleBillingCheckout(req);
    return errorResponse(404, "Not found");
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("api top-level failure:", message);
    return errorResponse(500, "Internal server error");
  }
});
