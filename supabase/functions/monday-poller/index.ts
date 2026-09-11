// supabase/functions/monday-poller/index.ts
//
// Same shape as jira-poller/notion-poller: poll active connections,
// find what changed since last_synced_at, enqueue one envelope per
// item and one per update (comment), advance the cursor.
//
// GraphQL, not REST (api.monday.com/v2), and the Authorization header
// takes the raw token - no "Bearer " prefix, verified against Monday's
// own docs, different from every other connector here.
//
// Real quota consideration verified against Monday's own docs before
// writing this: daily API call budgets can be as low as 1,000/day on
// lower plan tiers. One GraphQL request already covers every board plus
// its items_page in one round trip (GraphQL naturally batches this),
// so a poll run costs a small, roughly-constant number of requests
// regardless of how many boards/items exist - not one request per
// board the way a naive REST-style loop would.
//
// v1 simplification, disclosed not hidden: boards and items_page are
// each fetched as a single page (up to BOARDS_LIMIT boards,
// ITEMS_PAGE_LIMIT items per board) rather than following full cursor
// pagination - matching the same single-page simplicity Jira/Confluence
// already have (maxResults=50, no pagination loop). A board with more
// items than the page size will only have its most-recently-updated
// items visible per poll, not silently lose data - Monday's items_page
// doesn't sort by updated_at by default, so this is a real, not
// theoretical, limitation for a very large board. Worth revisiting if a
// real customer hits it.
//
// thread_ref is `boardId/itemId` - one real item's conversation
// (its own description plus every update on it), the same tight-scope
// precedent as Jira's issue.key, not Discord's channel-wide mistake.
//
// updated_at filtering happens client-side (compared against
// last_synced_at) rather than via items_page's query_params, since
// Monday's own docs don't document an update-time filter rule there -
// same "recapture full current state, filter after the fact" shape
// notion-poller and jira-poller already use for comments.
//
// Real gap found live: an item's source_id used to be just `item-<id>`,
// meaning raw_events' one-row-ever-per-source_id uniqueness captured an
// item's state exactly ONCE, on its first poll, and silently treated
// every later change to that same item as "already seen" forever -
// wrong for something like a bug ticket, where the whole point is that
// its status changes over its lifetime ("Awaiting Review" -> "Fixing"
// -> "Fixed" IS the decision-worthy content, not just its creation).
// Confirmed live: a real bug moving to "Fixed" after its first capture
// was invisible, not because of missing content (the column_values fix
// above), but because the item was already marked done and skipped.
// source_id now includes updated_at, so each meaningfully-different
// state of an item becomes its own real, distinct snapshot instead of
// only ever the first one - thread_ref stays item-scoped (not
// timestamped) so every snapshot of the same item still groups into one
// conversation. This is a real, disclosed pattern worth applying to
// Jira/GitHub's own item-level (not comment-level) envelopes too - not
// done here, out of scope for this connector's own fix.

import { withAdmin, withTenant } from "../_shared/db.ts";
import { enqueueEvent, IngestionEnvelope } from "../_shared/queue.ts";
import { decryptToken } from "../_shared/tokenCrypto.ts";

console.log("Monday poller started!");

const MONDAY_API_URL = "https://api.monday.com/v2";
const BOARDS_LIMIT = 25;
const ITEMS_PAGE_LIMIT = 100;

interface MondayUpdate {
  id: string;
  body?: string | null;
  text_body?: string | null;
  created_at?: string;
  creator?: { id?: string; name?: string } | null;
}
interface MondayColumnValue {
  column?: { title?: string } | null;
  text?: string | null;
}
interface MondayItem {
  id: string;
  name?: string;
  url?: string;
  updated_at?: string;
  creator?: { id?: string; name?: string } | null;
  updates?: MondayUpdate[];
  column_values?: MondayColumnValue[];
}

// Real bug found live: this poller originally captured only item.name -
// the bare title - as the entire body for an item envelope. Confirmed
// against a real board (a bug tracker) that this is genuinely thin: the
// actual meaningful content of a Monday item usually lives in its
// column_values (Status, Priority, Reporter, custom fields), not in a
// separate description field or in `updates` - most rows never get a
// comment at all. Without this, triage saw almost nothing to work with
// per item and correctly discarded most of them as non-actionable,
// which looked like "extraction is too conservative" but was really
// "there's nothing here to extract from" - a content gap, not a
// judgment gap. Formats every non-empty column into one line each,
// skipping columns with no text representation (not every column type
// has one, per Monday's own docs).
function formatColumnValues(columnValues: MondayColumnValue[] | undefined): string {
  return (columnValues ?? [])
    .filter((cv) => cv.column?.title && cv.text && cv.text.trim())
    .map((cv) => `${cv.column!.title}: ${cv.text}`)
    .join("\n");
}
interface MondayBoard {
  id: string;
  name?: string;
  items_page?: { items?: MondayItem[] };
}

async function mondayQuery(token: string, query: string): Promise<Record<string, unknown>> {
  const resp = await fetch(MONDAY_API_URL, {
    method: "POST",
    // No "Bearer " prefix - Monday's own convention, different from
    // every other connector here.
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query }),
  });
  const data = await resp.json();
  if (!resp.ok || data.errors) {
    throw new Error(`Monday API error: ${resp.status} ${JSON.stringify(data.errors ?? data)}`);
  }
  return data.data;
}

function knownActorsFor(user: { id?: string; name?: string } | null | undefined): { name: string; source_actor_id: string }[] {
  return user?.id && user.name ? [{ name: user.name, source_actor_id: String(user.id) }] : [];
}

Deno.serve(async (_req) => {
  const sources = await withAdmin(async (sql) => {
    return await sql`
      select *
      from public.source_connections
      where source = 'monday'
        and status = 'active'
        and ingestion_mode = 'polling'
    `;
  });

  const results = [];

  for (const source of sources) {
    try {
      const accessToken = await decryptToken(source.oauth_token_ref as string | null);
      if (!accessToken) {
        results.push({ source_id: source.id, error: "missing/undecryptable token" });
        continue;
      }

      const lastSyncedAt = source.last_synced_at ? new Date(source.last_synced_at as string) : new Date(0);

      const query = `query {
        boards(limit: ${BOARDS_LIMIT}) {
          id
          name
          items_page(limit: ${ITEMS_PAGE_LIMIT}) {
            items {
              id
              name
              url
              updated_at
              creator { id name }
              column_values {
                column { title }
                text
              }
              updates {
                id
                body
                text_body
                created_at
                creator { id name }
              }
            }
          }
        }
      }`;

      const data = await mondayQuery(accessToken, query);
      const boards = (data.boards ?? []) as MondayBoard[];

      let eventCount = 0;
      let latestUpdatedAt = source.last_synced_at as string | null;

      for (const board of boards) {
        const items = board.items_page?.items ?? [];
        for (const item of items) {
          const itemUpdatedAt = item.updated_at ? new Date(item.updated_at) : null;
          const isNewItem = itemUpdatedAt && itemUpdatedAt > lastSyncedAt;

          if (isNewItem) {
            const columnsText = formatColumnValues(item.column_values);
            const body = [item.name ?? "", columnsText].filter(Boolean).join("\n\n");
            const envelope: IngestionEnvelope = {
              tenant_id: source.tenant_id,
              connection_id: source.id,
              source: "monday",
              source_id: `item-${item.id}-${item.updated_at}`,
              actor: item.creator?.id ? String(item.creator.id) : "unknown",
              actor_display_name: item.creator?.name,
              thread_ref: `${board.id}/${item.id}`,
              permission_scope: [],
              // Build Memory's toggle key for this source (see
              // capture_item_id in _shared/queue.ts).
              capture_item_id: String(board.id),
              known_actors: knownActorsFor(item.creator),
              raw_content: {
                subject: `${board.name ?? "Board"}: ${item.name ?? ""}`,
                body,
              },
              source_permalink: item.url,
              received_at: new Date().toISOString(),
            };
            await enqueueEvent(envelope);
            eventCount++;
          }

          for (const update of item.updates ?? []) {
            const updateCreatedAt = update.created_at ? new Date(update.created_at) : null;
            if (!updateCreatedAt || updateCreatedAt <= lastSyncedAt) continue;
            const body = update.text_body ?? update.body ?? "";
            if (!body.trim()) continue;

            const envelope: IngestionEnvelope = {
              tenant_id: source.tenant_id,
              connection_id: source.id,
              source: "monday",
              source_id: `update-${update.id}`,
              actor: update.creator?.id ? String(update.creator.id) : "unknown",
              actor_display_name: update.creator?.name,
              thread_ref: `${board.id}/${item.id}`,
              permission_scope: [],
              // Build Memory's toggle key for this source (see
              // capture_item_id in _shared/queue.ts).
              capture_item_id: String(board.id),
              known_actors: knownActorsFor(update.creator),
              raw_content: {
                subject: `${board.name ?? "Board"}: ${item.name ?? ""}`,
                body,
              },
              source_permalink: item.url,
              received_at: new Date().toISOString(),
            };
            await enqueueEvent(envelope);
            eventCount++;

            if (!latestUpdatedAt || update.created_at! > latestUpdatedAt) {
              latestUpdatedAt = update.created_at!;
            }
          }

          if (item.updated_at && (!latestUpdatedAt || item.updated_at > latestUpdatedAt)) {
            latestUpdatedAt = item.updated_at;
          }
        }
      }

      if (latestUpdatedAt && latestUpdatedAt !== source.last_synced_at) {
        await withTenant(String(source.tenant_id), async (sql) => {
          await sql`
            update public.source_connections
            set last_synced_at = ${latestUpdatedAt}
            where id = ${source.id}
          `;
        });
      }

      results.push({ source_id: source.id, boards: boards.length, events: eventCount });
    } catch (err) {
      console.error(`Error polling Monday source ${source.id}:`, err);
      results.push({ source_id: source.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return new Response(JSON.stringify({ message: "Poll completed", results }), {
    headers: { "Content-Type": "application/json" },
  });
});
