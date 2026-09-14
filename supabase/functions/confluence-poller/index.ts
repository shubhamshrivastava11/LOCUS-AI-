// supabase/functions/confluence-poller/index.ts
//
// Same shape as notion-poller and jira-poller (see jira-poller's header
// comment for the shared reasoning: token refresh every run since
// Atlassian access tokens expire in ~1h, and the same raw_events
// (tenant_id, source, source_id) uniqueness limitation on re-ingesting an
// already-captured page's later edits).
//
// Confluence's page content comes back as "storage format" - XHTML-like
// markup, not ADF the way Jira's rich text is - so this reuses the
// existing cleanDisplayText()/htmlToPlainText() from _shared/htmlText.ts
// (the same HTML stripper Gmail's connector already uses for HTML email
// bodies) instead of a second rich-text parser.

import { withAdmin, withTenant } from "../_shared/db.ts";
import { enqueueEvent, IngestionEnvelope } from "../_shared/queue.ts";
import { refreshAtlassianAccess, type AtlassianConnection } from "../_shared/atlassianAuth.ts";
import { cleanDisplayText } from "../_shared/htmlText.ts";

console.log("Confluence poller started!");

// Same CQL date literal format as Jira's JQL (yyyy/MM/dd HH:mm, UTC
// components) - see jira-poller/index.ts's toJqlDate for the same
// timezone-simplification note, applies identically here.
function toCqlDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

interface ConfluencePage {
  id: string;
  title: string;
  body?: { storage?: { value?: string } };
  version?: { when?: string; by?: { accountId?: string; displayName?: string } };
  // Needs expand=space on the CQL search below, or this is always
  // undefined and the space toggle silently matches nothing.
  space?: { id?: number; key?: string };
  _links?: { webui?: string };
}

Deno.serve(async (_req) => {
  const sources = await withAdmin(async (sql) => {
    return await sql`
      select *
      from public.source_connections
      where source = 'confluence'
        and status = 'active'
        and ingestion_mode = 'polling'
    `;
  });

  const results = [];

  for (const source of sources) {
    try {
      const refreshed = await refreshAtlassianAccess(source as unknown as AtlassianConnection);
      if (!refreshed) {
        results.push({ source_id: source.id, error: "token refresh failed" });
        continue;
      }
      const { accessToken, cloudId } = refreshed;

      const lastSyncedAt = source.last_synced_at || new Date(0).toISOString();
      const cql = `lastmodified >= "${toCqlDate(lastSyncedAt)}" order by lastmodified asc`;
      // 3LO proxy format for the v1 REST API is .../ex/confluence/{cloudId}
      // /rest/api/... - NOT .../wiki/rest/api/... (that /wiki/ prefix only
      // belongs to the newer v2 API's path shape, .../wiki/api/v2/...).
      // Verified against Atlassian's own docs before writing this, not
      // assumed - got the equivalent wrong for Jira on the first pass
      // (deprecated /rest/api/3/search, fixed above) and didn't want to
      // repeat that here without checking first.
      const searchUrl = new URL(`https://api.atlassian.com/ex/confluence/${cloudId}/rest/api/content/search`);
      searchUrl.searchParams.set("cql", cql);
      searchUrl.searchParams.set("expand", "body.storage,version,space");
      searchUrl.searchParams.set("limit", "50");

      const response = await fetch(searchUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (!response.ok) {
        const bodyText = await response.text();
        console.error(`Confluence API error for ${source.id}:`, bodyText);
        results.push({ source_id: source.id, error: `search failed: ${response.status} ${bodyText}` });
        continue;
      }

      const data = await response.json();
      const pages: ConfluencePage[] = data.results ?? [];
      console.log(`Found ${pages.length} changed pages for ${source.id}`);

      for (const page of pages) {
        const bodyText = cleanDisplayText(page.body?.storage?.value ?? "");

        // Only the last editor is available from this search response
        // without an extra API call per page (page history isn't fetched
        // here) - a real, if smaller, identity roster than Jira's (which
        // also has comment authors). Still lets extraction's own
        // "mentioned" participants resolve to a real name when the last
        // editor is who they meant, same matching mechanism as jira-poller.
        const knownActors = page.version?.by?.accountId && page.version.by.displayName
          ? [{ name: page.version.by.displayName, source_actor_id: page.version.by.accountId }]
          : [];

        const envelope: IngestionEnvelope = {
          tenant_id: source.tenant_id,
          connection_id: source.id,
          source: "confluence",
          source_id: page.id,
          actor: page.version?.by?.accountId || "unknown",
          actor_display_name: page.version?.by?.displayName,
          thread_ref: page.id,
          permission_scope: source.external_workspace_id ? [String(source.external_workspace_id)] : [],
          // String(), because fetchRealItems stringifies Confluence's
          // numeric space id and the two have to compare equal.
          capture_item_id: page.space?.id !== undefined ? String(page.space.id) : undefined,
          known_actors: knownActors,
          raw_content: {
            subject: page.title,
            body: bodyText,
          },
          source_permalink: source.cursor_state?.site_url && page._links?.webui
            ? `${source.cursor_state.site_url}/wiki${page._links.webui}`
            : undefined,
          received_at: new Date().toISOString(),
        };
        await enqueueEvent(envelope);
      }

      if (pages.length > 0) {
        const latestModified = pages[pages.length - 1].version?.when;
        if (latestModified) {
          await withTenant(String(source.tenant_id), async (sql) => {
            await sql`
              update public.source_connections
              set last_synced_at = ${latestModified}
              where id = ${source.id}
            `;
          });
        }
      }

      results.push({ source_id: source.id, changed_pages: pages.length });
    } catch (err) {
      console.error(`Error polling Confluence source ${source.id}:`, err);
      results.push({ source_id: source.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return new Response(JSON.stringify({ message: "Poll completed", results }), {
    headers: { "Content-Type": "application/json" },
  });
});
