// supabase/functions/jira-poller/index.ts
//
// Same shape as notion-poller: poll active connections for this source,
// find what changed since last_synced_at, enqueue one envelope per
// changed issue, advance the cursor. Two real differences from Notion:
//
// 1. Atlassian access tokens expire in ~1h (Notion's never do) - every
//    run refreshes the token first via _shared/atlassianAuth.ts, not just
//    on a 401.
// 2. Jira's summary/description/comment bodies are Atlassian Document
//    Format (ADF), a rich-text JSON tree - not plain strings the way
//    Notion's page properties are. adfToText() below is a minimal walker
//    (paragraphs/headings/list items/code blocks get their own line,
//    inline marks are flattened to plain text) - good enough for
//    extraction to read, not a full ADF renderer.
//
// Same known limitation as notion-poller inherits from raw_events'
// (tenant_id, source, source_id) uniqueness: an issue that gets edited
// again AFTER its first capture won't be re-ingested - the dedup check in
// ai-worker treats the existing row as already-seen regardless of new
// content. Not something this poller introduces or fixes; matching
// existing, accepted behavior.

import { withAdmin, withTenant } from "../_shared/db.ts";
import { enqueueEvent, IngestionEnvelope } from "../_shared/queue.ts";
import { refreshAtlassianAccess, type AtlassianConnection } from "../_shared/atlassianAuth.ts";

console.log("Jira poller started!");

// deno-lint-ignore no-explicit-any
function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return `@${node.attrs?.text ?? node.attrs?.id ?? ""}`;
  const inner = Array.isArray(node.content) ? node.content.map(adfToText).join("") : "";
  const blockTypes = ["paragraph", "heading", "listItem", "codeBlock", "blockquote", "panel"];
  return blockTypes.includes(node.type) ? `${inner}\n` : inner;
}

// Jira's JQL date literal format - yyyy/MM/dd HH:mm, always interpreted
// in the Jira instance's own timezone. Using UTC components here is a
// deliberate simplification (not converting to the site's actual
// timezone) - it can shift the exact poll boundary by a few hours
// depending on the site's configured timezone, which only means an issue
// might be picked up slightly earlier or later than the precise instant,
// never missed outright, since JQL's own date resolution rounds to the
// minute already.
function toJqlDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

interface JiraComment {
  author?: { accountId?: string; displayName?: string };
  body?: unknown;
  created?: string;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    updated?: string;
    creator?: { accountId?: string; displayName?: string };
    // Requested so the envelope can carry capture_item_id. Without it the
    // project toggle in Build Memory has nothing to match against.
    project?: { id?: string; key?: string };
    comment?: { comments?: JiraComment[] };
  };
}

Deno.serve(async (_req) => {
  const sources = await withAdmin(async (sql) => {
    return await sql`
      select *
      from public.source_connections
      where source = 'jira'
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
      const jql = `updated >= "${toJqlDate(lastSyncedAt)}" ORDER BY updated ASC`;
      // /rest/api/3/search was removed by Atlassian (returns 410 Gone,
      // confirmed live) - /rest/api/3/search/jql is the real replacement.
      // Same query params, only pagination changed (nextPageToken instead
      // of startAt) - not handled here, same single-page simplicity
      // notion-poller already has (maxResults=50, no pagination loop).
      const searchUrl = new URL(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql`);
      searchUrl.searchParams.set("jql", jql);
      searchUrl.searchParams.set("fields", "summary,description,updated,creator,comment,project");
      searchUrl.searchParams.set("maxResults", "50");

      const response = await fetch(searchUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (!response.ok) {
        console.error(`Jira API error for ${source.id}:`, await response.text());
        results.push({ source_id: source.id, error: `search failed: ${response.status}` });
        continue;
      }

      const data = await response.json();
      const issues: JiraIssue[] = data.issues ?? [];
      console.log(`Found ${issues.length} changed issues for ${source.id}`);

      for (const issue of issues) {
        const descriptionText = adfToText(issue.fields.description).trim();
        const comments = issue.fields.comment?.comments ?? [];
        // All comments, not just new ones since last sync - same
        // "recapture full current state" shape notion-poller uses for a
        // page, and the only real option given raw_events' one-row-ever
        // constraint (see header comment) means this is the only chance
        // this issue's content ever reaches the pipeline.
        const commentsText = comments
          .map((c) => `${c.author?.displayName ?? "Unknown"}: ${adfToText(c.body).trim()}`)
          .join("\n\n");
        const body = [descriptionText, commentsText].filter(Boolean).join("\n\n");

        // Every real structured identity this issue actually has - the
        // creator plus every comment author - so extraction's own
        // "mentioned"/"decided_by" participants (identified from the raw
        // TEXT, which only ever gives a name) can be matched back to a
        // real account id + display name instead of showing "Unknown".
        // Deduped by accountId (the same person often comments more than
        // once).
        const knownActorsMap = new Map<string, string>();
        if (issue.fields.creator?.accountId && issue.fields.creator.displayName) {
          knownActorsMap.set(issue.fields.creator.accountId, issue.fields.creator.displayName);
        }
        for (const c of comments) {
          if (c.author?.accountId && c.author.displayName) {
            knownActorsMap.set(c.author.accountId, c.author.displayName);
          }
        }
        const knownActors = Array.from(knownActorsMap, ([source_actor_id, name]) => ({ name, source_actor_id }));

        const envelope: IngestionEnvelope = {
          tenant_id: source.tenant_id,
          connection_id: source.id,
          source: "jira",
          source_id: issue.key,
          actor: issue.fields.creator?.accountId || "unknown",
          actor_display_name: issue.fields.creator?.displayName,
          thread_ref: issue.key,
          permission_scope: source.external_workspace_id ? [String(source.external_workspace_id)] : [],
          // Same id capture-source-rules lists this project under.
          capture_item_id: issue.fields.project?.id,
          known_actors: knownActors,
          raw_content: {
            subject: issue.fields.summary ?? "",
            body,
          },
          source_permalink: source.cursor_state?.site_url
            ? `${source.cursor_state.site_url}/browse/${issue.key}`
            : undefined,
          received_at: new Date().toISOString(),
        };
        await enqueueEvent(envelope);
      }

      if (issues.length > 0) {
        const latestUpdated = issues[issues.length - 1].fields.updated;
        if (latestUpdated) {
          await withTenant(String(source.tenant_id), async (sql) => {
            await sql`
              update public.source_connections
              set last_synced_at = ${latestUpdated}
              where id = ${source.id}
            `;
          });
        }
      }

      results.push({ source_id: source.id, changed_issues: issues.length });
    } catch (err) {
      console.error(`Error polling Jira source ${source.id}:`, err);
      results.push({ source_id: source.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return new Response(JSON.stringify({ message: "Poll completed", results }), {
    headers: { "Content-Type": "application/json" },
  });
});
