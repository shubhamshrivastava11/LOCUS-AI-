import { withAdmin, withTenant } from "../_shared/db.ts";
import { enqueueEvent, IngestionEnvelope } from "../_shared/queue.ts";
import { decryptToken } from "../_shared/tokenCrypto.ts";

console.log("Notion poller started!");

// Notion caps page_size at 100.
const NOTION_PAGE_SIZE = 100;
// 10 pages = 1,000 changed pages per tick, which is far beyond any real
// five-minute window and still leaves the function well inside its
// timeout on a first sync.
const NOTION_MAX_PAGES = 10;

// Only the fields this poller actually reads are named; the rest of the
// page object is passed through to raw_content untouched.
interface NotionPage {
  id: string;
  last_edited_time: string;
  last_edited_by?: { id?: string };
  url?: string;
  [key: string]: unknown;
}

Deno.serve(async (_req) => {
  const sources = await withAdmin(async (sql) => {
    return await sql`
      select *
      from public.source_connections
      where source = 'notion'
        and status = 'active'
        and ingestion_mode = 'polling'
    `;
  });

  const results = [];

  for (const source of sources) {
    try {
      console.log(`Polling workspace: ${source.external_workspace_id}`);

      const accessToken = await decryptToken(source.oauth_token_ref);
      if (!accessToken) {
        console.error(`No access token for source ${source.id}`);
        continue;
      }

      const lastSyncedAt = source.last_synced_at || new Date(0).toISOString();

      // Was a single /search call whose has_more and next_cursor were both
      // ignored. Notion returns 100 results a page, so any workspace with
      // more changed pages than that in one window silently lost the
      // remainder - and because the sort is ascending by last_edited_time and
      // the checkpoint advances to the newest page SEEN, the unseen ones were
      // then behind the checkpoint and never came back.
      //
      // Bounded rather than unbounded: a first sync of a large workspace
      // should not run until the function times out. Stopping early is safe
      // here in a way it is not for Gmail, because the checkpoint only
      // advances to the last page actually processed, so the next tick
      // resumes from there.
      const pages: NotionPage[] = [];
      let cursor: string | undefined = undefined;
      let notionError = false;

      for (let pageNo = 0; pageNo < NOTION_MAX_PAGES; pageNo++) {
        const response = await fetch("https://api.notion.com/v1/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sort: {
              direction: "ascending",
              timestamp: "last_edited_time",
            },
            filter: {
              value: "page",
              property: "object",
            },
            page_size: NOTION_PAGE_SIZE,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        });

        if (!response.ok) {
          console.error(
            `Notion API error for ${source.id}:`,
            await response.text(),
          );
          notionError = true;
          break;
        }

        const data = await response.json();
        const batch = ((data.results ?? []) as NotionPage[]).filter(
          (page) => new Date(page.last_edited_time) > new Date(lastSyncedAt),
        );
        pages.push(...batch);

        // Results are sorted ascending by last_edited_time, so once a whole
        // page is older than the checkpoint everything after it is too.
        if (batch.length === 0 && (data.results ?? []).length > 0) break;
        if (!data.has_more || !data.next_cursor) break;
        cursor = data.next_cursor as string;
      }

      // A failed page mid-way would otherwise advance the checkpoint past
      // pages that were never enqueued.
      if (notionError && pages.length === 0) continue;

      console.log(`Found ${pages.length} changed pages for ${source.id}`);

      for (const page of pages) {
        const envelope: IngestionEnvelope = {
          tenant_id: source.tenant_id,
          source: "notion",
          // Dedup is keyed on (tenant_id, source, source_id), and ai-worker
          // skips any source_id already marked done. Keyed on the bare page id
          // that meant the FIRST version of a page was the only one ever
          // ingested: every later edit was fetched, matched the completed row,
          // and was discarded permanently. A Notion page that gets written
          // then filled in - which is how people actually use Notion - only
          // ever contributed its empty first draft.
          //
          // The edit timestamp makes each version its own event. thread_ref
          // below stays the bare page id, so versions still group together,
          // and capture_item_id stays the page id so the Build Memory toggle
          // still matches.
          source_id: `${page.id}#${page.last_edited_time}`,
          actor: page.last_edited_by?.id || "unknown",
          thread_ref: page.id,
          permission_scope: source.external_workspace_id ? [String(source.external_workspace_id)] : [],
          // Build Memory lists Notion pages by page id, which is what the
          // toggle is stored against - not the workspace id above.
          capture_item_id: String(page.id),
          raw_content: page,
          // Notion's Search API already returns the page's real URL - no
          // extra lookup needed, unlike Slack/Gmail.
          source_permalink: typeof page.url === "string" ? page.url : undefined,
          received_at: new Date().toISOString(),
        };
        await enqueueEvent(envelope);
      }

      if (pages.length > 0) {
        const latestTime = pages[pages.length - 1].last_edited_time;
        await withTenant(String(source.tenant_id), async (sql) => {
          await sql`
            update public.source_connections
            set last_synced_at = ${latestTime}
            where id = ${source.id}
          `;
        });
      }

      results.push({ source_id: source.id, changed_pages: pages.length });
    } catch (err) {
      console.error(`Error polling source ${source.id}:`, err);
    }
  }

  return new Response(JSON.stringify({ message: "Poll completed", results }), {
    headers: { "Content-Type": "application/json" },
  });
});
