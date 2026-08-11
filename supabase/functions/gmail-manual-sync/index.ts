import { withAdmin, withTenant } from "../_shared/db.ts";
import { enqueueEvent, IngestionEnvelope } from "../_shared/queue.ts";
import { htmlToPlainText } from "../_shared/htmlText.ts";
import { encryptToken } from "../_shared/tokenCrypto.ts";

console.log("Gmail manual sync started!");

const GMAIL_CLIENT_ID = Deno.env.get("GMAIL_CLIENT_ID");
const GMAIL_CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET");

// Plain fetch() never times out on its own - with every active Gmail
// connection processed sequentially in one invocation, a single stalled
// call (token refresh, list, or per-message fetch) blocks every other
// tenant's sync behind it. Same bug, same fix as ai-worker/index.ts.
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

/**
 * Google access tokens expire in ~1 hour; oauth_token_ref goes stale fast.
 * Refreshes it up front using the refresh_token captured at connect time
 * (stored in cursor_state by gmail-oauth's callback), and persists the new
 * access token so later syncs don't need to refresh again until it expires.
 */
// deno-lint-ignore no-explicit-any
async function refreshAccessToken(source: any): Promise<string | null> {
  const refreshToken = (source.cursor_state as Record<string, unknown> | null)?.refresh_token as
    | string
    | undefined;
  if (!refreshToken) {
    console.error(`No refresh_token stored for source ${source.id}; cannot refresh.`);
    return null;
  }

  const resp = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID ?? "",
      client_secret: GMAIL_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  }, 15_000);

  if (!resp.ok) {
    console.error(`Gmail token refresh failed for source ${source.id}:`, await resp.text());
    return null;
  }

  const data = await resp.json();
  const newAccessToken = data.access_token as string | undefined;
  if (!newAccessToken) return null;

  const encryptedToken = await encryptToken(newAccessToken);
  await withTenant(String(source.tenant_id), async (sql) => {
    await sql`
      update public.source_connections
      set oauth_token_ref = ${encryptedToken}
      where id = ${source.id}
    `;
  });

  return newAccessToken;
}

// Backfill is bounded to the 30 days before the connection was actually
// made (source.created_at, not "now" at sync time) - unbounded full-history
// backfill was tried and reverted: every previously-unseen old message costs
// a real Claude API call (triage, sometimes extraction) in ai-worker, and
// paging through months of a mailbox burned through tokens far faster than
// intended for what's still an early/testing deployment. 30 days from
// connect time is a fixed, deterministic window - no resumable "how far
// back have we gotten" cursor needed, just re-list the same bounded window
// each run until nothing new comes back, then flip to incremental.
const BACKFILL_LOOKBACK_DAYS = Number(Deno.env.get("GMAIL_BACKFILL_LOOKBACK_DAYS") ?? "30");
const BACKFILL_MAX_MESSAGES = Number(Deno.env.get("GMAIL_BACKFILL_MAX_MESSAGES") ?? "50");
const INCREMENTAL_MAX_MESSAGES = Number(Deno.env.get("GMAIL_INCREMENTAL_MAX_MESSAGES") ?? "50");
const LIST_PAGE_SIZE = 100; // Gmail's messages.list allows up to 500; 100 keeps each page fetch quick under fetchWithTimeout.

// Gmail's `after:` search operator wants YYYY/MM/DD (day granularity, no
// time component) - https://support.google.com/mail/answer/7190. Day
// granularity means a run's window can overlap the previous run's by up
// to a day; that's intentional and safe (re-listing an already-ingested
// message just costs one duplicate list entry, which store_raw_event()'s
// ON CONFLICT (tenant_id, source, source_id) DO NOTHING in ai-worker
// already no-ops on) - the alternative, rounding forward, risks silently
// skipping a message instead.
function formatGmailAfterDate(date: Date): string {
  return `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

// Paginates messages.list up to maxMessages total, honoring the same
// per-call timeout every other Gmail request in this file uses. Stops
// early once maxMessages is reached or Gmail reports no nextPageToken -
// never fetches more than the caller asked for, regardless of how large
// the actual result set is.
async function listGmailMessageIds(
  accessToken: string,
  query: string,
  maxMessages: number,
): Promise<{ id: string }[]> {
  const ids: { id: string }[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("maxResults", String(Math.min(LIST_PAGE_SIZE, maxMessages - ids.length)));
    if (query) url.searchParams.set("q", query);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const resp = await fetchWithTimeout(
      url.toString(),
      { headers: { Authorization: `Bearer ${accessToken}` } },
      15_000,
    );
    if (!resp.ok) {
      console.error(`Gmail list page failed (query=${query}):`, await resp.text());
      break;
    }
    const data = await resp.json();
    ids.push(...(data.messages ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < maxMessages);

  return ids.slice(0, maxMessages);
}

// Single-page fetch with an explicit resumable pageToken, used by the
// backfill path so progress can be persisted to cursor_state and picked up
// by the NEXT cron run instead of needing everything in one invocation.
async function listGmailMessagesPage(
  accessToken: string,
  query: string,
  pageToken: string | undefined,
  maxResults: number,
): Promise<{ ids: { id: string }[]; nextPageToken?: string }> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("maxResults", String(Math.min(LIST_PAGE_SIZE, Math.max(maxResults, 0))));
  if (query) url.searchParams.set("q", query);
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const resp = await fetchWithTimeout(
    url.toString(),
    { headers: { Authorization: `Bearer ${accessToken}` } },
    15_000,
  );
  if (!resp.ok) {
    console.error(`Gmail list page failed (query=${query}):`, await resp.text());
    return { ids: [] };
  }
  const data = await resp.json();
  return { ids: data.messages ?? [], nextPageToken: data.nextPageToken };
}

// Gmail nests multipart/mixed > multipart/alternative > leaf parts, sometimes
// several levels deep. The old extraction only ever looked at the top-level
// payload.body.data (used unconditionally regardless of mimeType - a
// single-part HTML-only message, common for newsletters with no plain-text
// alternative, dumped raw <!DOCTYPE>/<meta>/CSS straight into the stored
// body) or a one-level-deep search for a text/plain part (missing anything
// nested, and never falling back to text/html at all). This walks the whole
// tree and prefers text/plain, falling back to text/html.
type GmailMimePart = { mimeType?: string; body?: { data?: string }; parts?: GmailMimePart[] };

function findGmailBodyPart(node: GmailMimePart | undefined): { mimeType: string; data: string } | null {
  if (!node) return null;
  if (node.body?.data && (!node.parts || node.parts.length === 0)) {
    return { mimeType: node.mimeType ?? "", data: node.body.data };
  }
  if (node.parts) {
    let htmlFallback: { mimeType: string; data: string } | null = null;
    for (const part of node.parts) {
      const found = findGmailBodyPart(part);
      if (!found) continue;
      if (found.mimeType === "text/plain") return found;
      if (found.mimeType === "text/html" && !htmlFallback) htmlFallback = found;
    }
    return htmlFallback;
  }
  return null;
}

// atob() returns a "binary string" - one JS character per raw byte - not a
// decoded Unicode string. Gmail bodies are UTF-8, so a multi-byte sequence
// (a curly quote, a non-breaking space) was being read back as 2-3 separate
// Latin-1 characters instead of the one real character it was (confirmed
// live: a curly-quoted "LOCUS AI." stored as "â€œLOCUS AI.â€\x9d"). Decoding
// the raw bytes as UTF-8 afterward reassembles them correctly.
function decodeGmailBase64(data: string): string {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

// Lowered alongside BACKFILL_MAX_MESSAGES for the same reason - fewer
// sources doing full-history paging in parallel within one invocation.
const SYNC_CONCURRENCY = 2;

// Runs syncOneSource(source) for every source with at most `concurrency` in
// flight at once - one tenant's stalled OAuth/Gmail call (now bounded to
// 15s by fetchWithTimeout, but 15s x up to 12 sequential calls still adds
// up) no longer serializes behind every other tenant's sync.
// deno-lint-ignore no-explicit-any
async function runBounded(sources: any[], concurrency: number, fn: (source: any) => Promise<unknown>) {
  const results: unknown[] = [];
  let i = 0;
  async function worker() {
    while (i < sources.length) {
      const source = sources[i++];
      results.push(await fn(source));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  return results;
}

Deno.serve(async (_req) => {
  // Cross-tenant list of active Gmail connections (admin / bypass)
  const sources = await withAdmin(async (sql) => {
    return await sql`
      select *
      from public.source_connections
      where source = 'gmail'
        and status = 'active'
    `;
  });

  // deno-lint-ignore no-explicit-any
  async function syncOneSource(source: any) {
    // Captured before any fetching starts, not after: last_synced_at is set
    // to this value at the end of a successful run, so a message that
    // arrives WHILE this run is in flight is still >= the next run's
    // `after:` bound (a little overlap, dedup-safe) instead of falling into
    // the gap between "when this run listed messages" and "when it finished".
    const syncStartedAt = new Date();
    try {
      console.log(`Syncing Gmail: ${source.external_workspace_id}`);

      const accessToken = await refreshAccessToken(source);
      if (!accessToken) {
        console.error(`Unable to obtain a valid access token for source ${source.id}`);
        return { source_id: source.id, messages_synced: 0, error: "no_access_token" };
      }

      // last_synced_at is set only once a source's backfill has fully
      // finished (see the update at the end of this function) - null here
      // means backfill is still in progress (or hasn't started), so this
      // run continues paging through the bounded backfill window rather
      // than switching to incremental catch-up.
      const cursorState = (source.cursor_state ?? {}) as Record<string, unknown>;
      const backfilling = !source.last_synced_at;

      let messages: { id: string }[];
      let query: string;
      let nextBackfillPageToken: string | undefined;

      if (backfilling) {
        // Fixed window anchored to when this connection was actually made,
        // not "now" - a connection that's sat idle for two weeks still only
        // backfills the 30 days before it was connected, not 30 days before
        // today. Deterministic from source.created_at, so no cursor_state
        // lookup is needed to know the query - only the pageToken (if this
        // connection's window has more than BACKFILL_MAX_MESSAGES in it)
        // needs to persist across runs.
        const cutoff = new Date(
          new Date(source.created_at).getTime() - BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
        );
        query = `after:${formatGmailAfterDate(cutoff)}`;
        const page = await listGmailMessagesPage(
          accessToken,
          query,
          cursorState.backfill_page_token as string | undefined,
          BACKFILL_MAX_MESSAGES,
        );
        messages = page.ids;
        nextBackfillPageToken = page.nextPageToken;
      } else {
        query = `after:${formatGmailAfterDate(new Date(source.last_synced_at))}`;
        messages = await listGmailMessageIds(accessToken, query, INCREMENTAL_MAX_MESSAGES);
      }

      console.log(
        `${backfilling ? "Backfilling" : "Incrementally syncing"} ${source.external_workspace_id} `
          + `(query="${query || "<all mail>"}", found ${messages.length})`,
      );

      let syncedCount = 0;

      for (const msgMeta of messages) {
        const msgResp = await fetchWithTimeout(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgMeta.id}?format=full`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
          15_000,
        );
        if (!msgResp.ok) {
          console.error(`Failed to fetch message ${msgMeta.id}:`, await msgResp.text());
          continue;
        }
        const rawMsg = await msgResp.json();

        const headers = rawMsg.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h: { name?: string; value?: string }) =>
            h.name?.toLowerCase() === name.toLowerCase()
          )?.value || "";

        let body = "";
        const payload = rawMsg.payload || {};
        const bodyPart = findGmailBodyPart(payload);
        if (bodyPart) {
          const decoded = decodeGmailBase64(bodyPart.data);
          body = bodyPart.mimeType === "text/html" ? htmlToPlainText(decoded) : decoded;
        }
        if (!body) body = rawMsg.snippet || "";

        const fromHeader = getHeader("From");
        // Gmail's From header is usually `"Real Name" <email>` - the name
        // is right there for free, no extra lookup needed, but was being
        // discarded entirely (only the bracketed email was kept), so
        // Gmail participants only ever showed a raw email address.
        const actorMatch = fromHeader.match(/^\s*"?([^"<]*?)"?\s*<(.+)>\s*$/);
        const actor = actorMatch ? actorMatch[2] : fromHeader;
        const actorDisplayName = actorMatch && actorMatch[1].trim() ? actorMatch[1].trim() : undefined;

        // rawMsg.internalDate is Gmail's own epoch-milliseconds timestamp
        // for when the message actually arrived - the reliable source,
        // unlike the Date: header (inconsistent formats, sender-controlled,
        // can be wrong/missing). Without this, every message - live or
        // backfilled - got stamped with "now" (see ai-worker's matching fix
        // to actually use this field instead of defaulting to now() itself),
        // so a real backfill of month-old mail would still show up as if it
        // all happened today.
        const internalDateMs = Number(rawMsg.internalDate);
        const messageReceivedAt = Number.isFinite(internalDateMs) && internalDateMs > 0
          ? new Date(internalDateMs).toISOString()
          : new Date().toISOString();

        // List-Unsubscribe (RFC 2369/8058) is the header every compliant
        // bulk/marketing mailer includes - real personal or work
        // correspondence essentially never carries it, so its presence is a
        // safe, conservative signal that this is a newsletter/digest/
        // automated notice. Skipping the Claude call entirely for these
        // (see ai-worker's handleIngestionMessageInner) costs nothing and
        // avoids triage spend on content that was always going to be
        // discarded anyway - this is what the Charger Bands newsletter
        // false-positive decision should have hit before it ever reached
        // the model.
        const likelyBulkMail = Boolean(getHeader("List-Unsubscribe"));

        const envelope: IngestionEnvelope = {
          tenant_id: source.tenant_id,
          connection_id: source.id,
          source: "gmail",
          source_id: rawMsg.id,
          actor: actor || "unknown",
          actor_display_name: actorDisplayName,
          thread_ref: rawMsg.threadId,
          permission_scope: source.external_workspace_id ? [String(source.external_workspace_id)] : [],
          likely_bulk_mail: likelyBulkMail,
          raw_content: {
            subject: getHeader("Subject"),
            body,
            from: fromHeader,
            to: getHeader("To"),
            date: getHeader("Date"),
            snippet: rawMsg.snippet,
          },
          // #all/{id} works regardless of which label the message is filed
          // under (inbox, archived, etc.), unlike #inbox/{id}. authuser must
          // be the real email, not a hardcoded /u/0/ index - /u/0/ is
          // whichever Google account happens to be first in that browser's
          // own session, which is almost never guaranteed to be the one
          // Locus is actually connected to. Confirmed live: a PM with more
          // than one Google account logged in clicked "View Original" and
          // landed on their own default mailbox's inbox, not the specific
          // message, because /u/0/ pointed at the wrong account entirely.
          source_permalink: `https://mail.google.com/mail/?authuser=${encodeURIComponent(source.external_workspace_id ?? "")}#all/${rawMsg.id}`,
          received_at: messageReceivedAt,
        };

        await enqueueEvent(envelope);
        syncedCount++;
      }

      if (backfilling) {
        if (nextBackfillPageToken) {
          // More messages remain within the 30-day window - stay in
          // backfill mode, save the resume point for the next cron run.
          // last_synced_at stays null on purpose.
          await withTenant(String(source.tenant_id), async (sql) => {
            await sql`
              update public.source_connections
              set cursor_state = cursor_state || ${sql.json({ backfill_page_token: nextBackfillPageToken })}::jsonb
              where id = ${source.id}
            `;
          });
        } else {
          // Reached the end of the 30-day window - backfill is done,
          // switch to incremental going forward.
          await withTenant(String(source.tenant_id), async (sql) => {
            await sql`
              update public.source_connections
              set cursor_state = cursor_state - 'backfill_page_token',
                  last_synced_at = ${syncStartedAt.toISOString()}
              where id = ${source.id}
            `;
          });
        }
      } else {
        await withTenant(String(source.tenant_id), async (sql) => {
          await sql`
            update public.source_connections
            set last_synced_at = ${syncStartedAt.toISOString()}
            where id = ${source.id}
          `;
        });
      }

      return { source_id: source.id, messages_synced: syncedCount, backfilling };
    } catch (err) {
      console.error(`Error syncing source ${source.id}:`, err);
      return { source_id: source.id, messages_synced: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const results = await runBounded(sources, SYNC_CONCURRENCY, syncOneSource);

  return new Response(JSON.stringify({ message: "Sync completed", results }), {
    headers: { "Content-Type": "application/json" },
  });
});
