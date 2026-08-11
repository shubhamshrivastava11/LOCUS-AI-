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
import * as jose from "npm:jose@5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

type ThreadMessage = { at: string; actor: string; source: string; text: string };

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
// deno-lint-ignore no-explicit-any
async function buildThreadContext(
  sql: any,
  tenantId: string,
  originRawEventId: string | null,
  sourceRawEventIds: string[],
): Promise<ThreadMessage[]> {
  const rawEventIds = [...new Set([originRawEventId, ...sourceRawEventIds].filter((id): id is string => !!id))];
  if (rawEventIds.length === 0) return [];

  try {
    const threadRefRows = await sql`
      SELECT DISTINCT thread_ref FROM public.raw_events
      WHERE id = ANY(${rawEventIds}) AND tenant_id = ${tenantId} AND thread_ref IS NOT NULL
    `;
    const threadRefs = threadRefRows.map((r: { thread_ref: string }) => r.thread_ref);

    // raw_events has no plain-text "actor" column - only actor_id (a
    // foreign key the current ingestion pipeline never populates). The
    // real actor identity only ever existed inside the encrypted envelope
    // itself, which is already being decrypted below anyway.
    const eventRows = threadRefs.length > 0
      ? await sql`
          SELECT id, source, received_at, raw_content FROM public.raw_events
          WHERE thread_ref = ANY(${threadRefs}) AND tenant_id = ${tenantId}
          ORDER BY received_at ASC
        `
      : await sql`
          SELECT id, source, received_at, raw_content FROM public.raw_events
          WHERE id = ANY(${rawEventIds}) AND tenant_id = ${tenantId}
          ORDER BY received_at ASC
        `;

    // deno-lint-ignore no-explicit-any
    const decrypted: { at: string; rawActor: string; source: string; text: string }[] = [];
    for (const row of eventRows) {
      try {
        const bytes = byteaToUint8Array(row.raw_content);
        const plaintext = await decryptRawContent(bytes);
        const envelope = JSON.parse(plaintext) as { raw_content?: unknown; actor?: string };
        const text = extractEventText(envelope.raw_content, row.source);
        decrypted.push({ at: row.received_at, rawActor: envelope.actor ?? "unknown", source: row.source, text });
      } catch (err) {
        console.error(`Failed to decrypt/parse raw_event ${row.id}:`, err);
      }
    }

    // Envelopes only ever carry the raw platform identifier (a Slack "U..."
    // id, a Notion user id, a Gmail address) - resolve to real names the
    // same way decision participants already are, instead of showing raw
    // ids in the reconstructed conversation.
    const rawActorIds = [...new Set(decrypted.map((m) => m.rawActor))];
    const actorNameByRawId = new Map<string, string>();
    if (rawActorIds.length > 0) {
      const actorRows = await sql`
        SELECT display_name, email, notion_user_id, slack_user_id FROM public.actors
        WHERE tenant_id = ${tenantId}
          AND (slack_user_id = ANY(${rawActorIds}) OR notion_user_id = ANY(${rawActorIds}) OR email = ANY(${rawActorIds}))
      `;
      for (const ar of actorRows) {
        const name = guessActorName(ar.display_name, ar.email, ar.notion_user_id, ar.slack_user_id);
        if (!name) continue;
        for (const rawId of [ar.slack_user_id, ar.notion_user_id, ar.email]) {
          if (rawId) actorNameByRawId.set(rawId, name);
        }
      }
    }

    const unresolvedSlackIds = rawActorIds.filter((id) => !actorNameByRawId.has(id) && SLACK_USER_ID_RE.test(id));
    if (unresolvedSlackIds.length > 0) {
      const liveResolved = await resolveSlackNamesLive(sql, tenantId, unresolvedSlackIds);
      for (const [id, name] of liveResolved) actorNameByRawId.set(id, name);
    }

    return decrypted.map((m) => ({
      at: m.at,
      actor: actorNameByRawId.get(m.rawActor) ?? m.rawActor,
      source: m.source,
      text: m.text,
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

type TenantContext = { userId: string; tenantId: string; role: string };

async function verifyTenantJwt(token: string): Promise<TenantContext> {
  const secret = new TextEncoder().encode(requireEnv("APP_SECRET_KEY"));
  const { payload } = await jose.jwtVerify(token, secret, { issuer: TENANT_JWT_ISSUER });
  if (!payload.tenant_id) throw new Error("JWT missing tenant_id claim");
  return {
    userId: String(payload.sub),
    tenantId: String(payload.tenant_id),
    role: String(payload.role ?? "member"),
  };
}

async function getCurrentTenant(req: Request): Promise<TenantContext> {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Missing Authorization: Bearer token");
  return await verifyTenantJwt(match[1]);
}

// source_connections has no per-user column at all - it's tenant-wide, not
// tied to whichever member happened to click "Connect". Scoping access to
// only the caller's own login email meant a decision captured from a
// connected Gmail account was invisible to every tenant member except the
// one whose Supabase login email happened to exactly match the connected
// Gmail address - in practice, "log in with Gmail and connect with that
// same Gmail" was the only way anything ever showed up. Real fix: grant
// every tenant member visibility into every source actually connected to
// their tenant, not just their own identity. Broader than Gmail alone
// (also covers Slack/Notion workspace ids) since the same gap applies to
// all three connectors identically, not just Gmail.
async function resolvePermissionScopes(userId: string, tenantId: string): Promise<string[]> {
  const email = await withAdmin(async (sql) => {
    const rows = await sql`SELECT email FROM auth.users WHERE id = ${userId}`;
    return rows[0]?.email ?? null;
  });

  const connectedScopes = await withTenant(tenantId, async (sql) => {
    const rows = await sql`
      SELECT DISTINCT external_workspace_id FROM public.source_connections
      WHERE tenant_id = ${tenantId} AND status = 'active' AND external_workspace_id IS NOT NULL
    `;
    return rows.map((r) => r.external_workspace_id as string);
  });

  const scopes = new Set<string>(connectedScopes);
  if (email) scopes.add(email);
  return [...scopes];
}

// ── Handler: POST /auth/session ────────────────────────────────────────
async function handleAuthSession(req: Request): Promise<Response> {
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

  const tenantId = membership.tenant_id as string;
  const role = membership.role as string;
  const plan = membership.plan as string;
  const token = await signTenantJwt(authUserId, tenantId, role);

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
  };
}

async function listDecisions(
  tenantId: string,
  limit: number,
  offset: number,
  recordType?: string | null,
  source?: string | null,
) {
  return await withTenant(tenantId, async (sql) => {
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
             d.origin_raw_event_id, d.created_at, d.updated_at
      FROM decisions d
      LEFT JOIN raw_events re ON re.id = d.origin_raw_event_id AND re.tenant_id = d.tenant_id
      WHERE d.tenant_id = ${tenantId} AND d.superseded_by IS NULL ${recordTypeFilter} ${sourceFilter}
      ORDER BY d.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
    const totalRows = await sql`
      SELECT COUNT(*)::int AS total
      FROM decisions d
      LEFT JOIN raw_events re ON re.id = d.origin_raw_event_id AND re.tenant_id = d.tenant_id
      WHERE d.tenant_id = ${tenantId} AND d.superseded_by IS NULL ${recordTypeFilter} ${sourceFilter}
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

async function getDecisionById(tenantId: string, decisionId: string) {
  return await withTenant(tenantId, async (sql) => {
    const rows = await sql`
      SELECT id, tenant_id, record_type, decision_statement, rationale,
             alternatives_considered, status, superseded_by, scope, confidence,
             origin_raw_event_id, created_at, updated_at
      FROM decisions WHERE id = ${decisionId} AND tenant_id = ${tenantId}
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

async function searchSimilarDecisions(tenantId: string, embedding: number[], topK: number): Promise<RetrievalMatch[]> {
  const vectorLiteral = "[" + embedding.join(",") + "]";
  return await withTenant(tenantId, async (sql) => {
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
      WHERE d.tenant_id = ${tenantId}
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

async function searchDecisionsKeyword(tenantId: string, question: string, topK: number): Promise<RetrievalMatch[]> {
  const query = question.trim();
  if (!query) return [];
  return await withTenant(tenantId, async (sql) => {
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
      WHERE d.tenant_id = ${tenantId}
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
): Promise<RetrievalMatch[]> {
  const fetchK = Math.max(candidateK, topK);
  const embedding = await embedQuery(embeddingQuery || question);
  const [vectorMatches, keywordMatches] = await Promise.all([
    searchSimilarDecisions(tenantId, embedding, fetchK),
    searchDecisionsKeyword(tenantId, keywordQuery || question, fetchK),
  ]);
  return fuseRrf(vectorMatches, keywordMatches, fetchK);
}

// ── Permissions: Layer 2 authorization (mirrors modules/permissions) ─────

const SLACK_CHANNEL_RE = /^C[A-Z0-9]{8,}$/;
const NOTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUnmappedScope(scope: string): boolean {
  return SLACK_CHANNEL_RE.test(scope) || NOTION_ID_RE.test(scope);
}

function isDecisionAccessible(permissionScopes: string[], decision: RetrievalMatch): boolean {
  if (!decision.permission_scope || decision.permission_scope.length === 0) return true;
  if (decision.permission_scope.some((s) => permissionScopes.includes(s))) return true;
  return decision.permission_scope.every(isUnmappedScope);
}

function filterAccessibleDecisions(permissionScopes: string[], matches: RetrievalMatch[]): RetrievalMatch[] {
  return matches.filter((m) => isDecisionAccessible(permissionScopes, m));
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

  let body: { question?: string; top_k?: number };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  const question = (body.question ?? "").trim();
  if (!question) return errorResponse(422, "question is required");
  const requestedTopK = Math.min(Math.max(body.top_k ?? DEFAULT_TOP_K, 1), MAX_TOP_K);

  try {
    const permissionScopes = await resolvePermissionScopes(ctx.userId, ctx.tenantId);
    const analysis = await analyzeQuery(question);

    let effectiveTopK = Math.max(requestedTopK, RERANK_MIN_TOP_K);
    if (analysis.is_multi_document) {
      effectiveTopK = Math.min(MAX_TOP_K, Math.max(effectiveTopK, MULTI_DOCUMENT_MIN_TOP_K));
    }
    const candidateK = Math.max(DEFAULT_CANDIDATE_K, effectiveTopK * 2);

    const candidates = await hybridRetrieve(
      ctx.tenantId, question, effectiveTopK, candidateK, question, keywordSearchQuery(analysis),
    );

    const authorized = filterAccessibleDecisions(permissionScopes, candidates);
    // No cross-encoder here (see file header) - truncate to effectiveTopK directly,
    // reproducing that module's own fail-open fallback path exactly.
    const finalMatches = authorized.slice(0, effectiveTopK);

    const context = formatContext(finalMatches);
    const answerResult = await generateAnswer(question, context, analysis);
    const citations = buildCitations(answerResult.citations, finalMatches);

    return jsonResponse({
      answer: answerResult.answer,
      citations,
      reasoning: answerResult.reasoning,
      confidence: answerResult.confidence,
      metadata: {
        model: answerResult.model,
        latency_ms: 0,
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
    return errorResponse(502, err instanceof Error ? err.message : "Search failed");
  }
}

// ── Handler: GET /digest ──────────────────────────────────────────────

const DIGEST_TOP_K = 25;
const TEAM_QUESTION = "What were the most important decisions made by the team this week? Summarize them clearly, grouped by theme if helpful.";

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

async function generateTeamPulse(tenantId: string, permissionScopes: string[], scope: "personal" | "team", userId: string | null) {
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
  const authorized = filterAccessibleDecisions(permissionScopes, matches);
  const context = formatContext(authorized);
  // A weekly digest is multi-document by definition (it's summarizing every
  // decision from the past week, not answering one specific question) -
  // passing null here skipped MULTI_DOCUMENT_INSTRUCTION entirely, so the
  // model wrote one run-on paragraph mixing every theme together instead of
  // a per-item breakdown.
  const digestAnalysis: QueryAnalysis = {
    intent: "Weekly digest of the team's recorded decisions, action items, and blockers.",
    question_type: "summary", entities: [], keywords: [],
    department_guess: "", is_multi_document: true,
  };
  const answerResult = await generateAnswer(question, context, digestAnalysis);

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
    scope, period, summary: answerResult.answer, items,
    metadata: {
      model: answerResult.model, latency_ms: 0, decision_count: authorized.length,
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
    const permissionScopes = await resolvePermissionScopes(ctx.userId, ctx.tenantId);
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

    const digest = await generateTeamPulse(ctx.tenantId, permissionScopes, scope, userId);
    try {
      await saveWeeklyDigest(ctx.tenantId, digest, requestedWeekOf, userId);
    } catch (err) {
      console.error("Failed to persist digest:", err);
    }
    return jsonResponse(digest);
  } catch (err) {
    console.error("digest failed:", err);
    return errorResponse(502, err instanceof Error ? err.message : "Digest generation failed");
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

  if (req.method === "GET" && parts.length === 0) {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    const recordType = url.searchParams.get("record_type");
    const source = url.searchParams.get("source");
    try {
      const result = await listDecisions(ctx.tenantId, limit, offset, recordType, source);
      return jsonResponse(result);
    } catch (err) {
      console.error("list decisions failed:", err);
      return errorResponse(500, "Failed to list decisions");
    }
  }

  if (req.method === "GET" && parts.length === 1) {
    try {
      const decision = await getDecisionById(ctx.tenantId, parts[0]);
      if (!decision) return errorResponse(404, "Decision not found");
      return jsonResponse(decision);
    } catch (err) {
      console.error("get decision failed:", err);
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
    if (path.endsWith("/billing/checkout") && req.method === "POST") return await handleBillingCheckout(req);
    return errorResponse(404, "Not found");
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("api top-level failure:", message);
    return errorResponse(500, "Internal server error");
  }
});
