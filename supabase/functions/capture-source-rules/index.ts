// supabase/functions/capture-source-rules/index.ts
//
// Backs frontend/src/pages/SettingsPage.tsx's Capture Controls > "Channels &
// Source Rules" table with real data: real Slack channels / Notion pages /
// Gmail labels (fetched live from each provider using the tenant's already-
// stored oauth_token_ref, same tokens gmail-manual-sync/notion-poller/
// slack-webhook use), merged with real persisted include/exclude state from
// capture_source_rules (migration 015).
//
// Auth: same pattern as search-history/delete-account - a raw Supabase-
// issued access token, verified via supabase.auth.getUser(token).
//
// Actions (POST body: { action, ... }):
//   list       -> { items: [{ source, item_id, item_name, included }] }
//   toggle     -> { source, item_id, item_name, included } -> { included }
//   disconnect -> { connection_id, delete_history? } -> { success }
//
// The frontend's "Disconnect" button called this file's "disconnect" /
// "disconnect_and_delete" actions since before this file existed in its
// current form - neither one was ever implemented here, so every disconnect
// attempt silently failed with "Unknown action". Scoped by connection_id,
// not by source type: a tenant can have more than one active connection per
// source (see the "list" handler's own comment on this same fact), and
// disconnecting one specific Gmail account should never touch a second one.

import { getServiceClient } from "../_shared/supabase.ts";
import { decryptToken } from "../_shared/tokenCrypto.ts";
import { refreshAtlassianAccess, type AtlassianConnection } from "../_shared/atlassianAuth.ts";
import { githubApiHeaders, mintInstallationToken } from "../_shared/githubAuth.ts";
import { Trace } from "../_shared/trace.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-region",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Source = "slack" | "gmail" | "notion" | "jira" | "confluence" | "discord" | "github" | "monday" | "clickup" | "teams";
type RealItem = { source: Source; item_id: string; item_name: string };

const DISCORD_BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN");

function getNotionPageTitle(page: Record<string, unknown>): string {
  const props = (page.properties as Record<string, unknown> | undefined) ?? {};
  for (const key of Object.keys(props)) {
    const prop = props[key] as { type?: string; title?: { plain_text?: string }[] };
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      const text = prop.title.map((t) => t.plain_text ?? "").join("");
      if (text) return text;
    }
  }
  return "Untitled";
}

// Jira projects / Confluence spaces need the resolved cloud_id (the
// 3LO proxy path is .../ex/{jira|confluence}/{cloudId}/...), unlike
// Slack/Gmail/Notion which call the provider's own api.* domain directly
// with just the access token.
async function fetchRealItems(source: Source, accessToken: string, cloudId?: string): Promise<RealItem[]> {
  if (source === "clickup") {
    // cloudId doubles as team_id here - the same "extra per-connection
    // id" param Jira/Confluence already pass through for their own
    // cloudId, not a new concept.
    const teamId = cloudId;
    if (!teamId) return [];
    const resp = await fetch(`https://api.clickup.com/api/v2/team/${teamId}/space`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const spaces = (data.spaces ?? []) as { id: string; name: string }[];
    return spaces.map((s) => ({ source: "clickup" as const, item_id: s.id, item_name: s.name }));
  }

  if (source === "monday") {
    // GraphQL, and the Authorization header takes the raw token - no
    // "Bearer " prefix, same real gotcha noted in monday-oauth/
    // monday-poller. accessToken here is already the decrypted token
    // (this function is only ever called with one, matching every other
    // non-Atlassian/Discord/GitHub source's plain-token shape).
    const resp = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: accessToken },
      body: JSON.stringify({ query: "query { boards(limit: 50) { id name } }" }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const boards = (data.data?.boards ?? []) as { id: string; name: string }[];
    return boards.map((b) => ({ source: "monday" as const, item_id: b.id, item_name: b.name }));
  }

  if (source === "jira") {
    // /rest/api/3/project/search is the current, non-deprecated endpoint -
    // verified directly against Atlassian's own docs before using this,
    // not assumed (the sibling issue-search endpoint was found removed
    // entirely earlier this session).
    const resp = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project/search`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const projects = (data.values ?? []) as { id: string; key: string; name: string }[];
    return projects.map((p) => ({ source: "jira" as const, item_id: p.id, item_name: `${p.key} - ${p.name}` }));
  }

  if (source === "confluence") {
    // v1 /wiki/rest/api/space is deprecated (v2 /wiki/api/v2/spaces is the
    // replacement, wants a read:space:confluence scope this app doesn't
    // have yet) but still functional as of this write - reusing the
    // scopes already granted (search:confluence's own description says it
    // also covers space-summary data) rather than requesting a fourth
    // scope + another disconnect/reconnect cycle unless a real live call
    // proves that's actually necessary.
    const resp = await fetch(`https://api.atlassian.com/ex/confluence/${cloudId}/wiki/rest/api/space?limit=100`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const spaces = (data.results ?? []) as { id: number; key: string; name: string }[];
    return spaces.map((s) => ({ source: "confluence" as const, item_id: String(s.id), item_name: s.name }));
  }

  if (source === "notion") {
    const resp = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filter: { value: "page", property: "object" } }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const pages = (data.results ?? []) as Record<string, unknown>[];
    return pages.map((page) => ({
      source: "notion" as const,
      item_id: String(page.id),
      item_name: getNotionPageTitle(page),
    }));
  }

  if (source === "slack") {
    const resp = await fetch(
      "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.ok) return [];
    const channels = (data.channels ?? []) as { id: string; name: string }[];
    return channels.map((c) => ({ source: "slack" as const, item_id: c.id, item_name: `#${c.name}` }));
  }

  // gmail: labels are the closest real analog to a "channel" - a source a
  // user can meaningfully include/exclude, unlike scanning all senders.
  const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  // User-created labels plus the handful of system labels meaningful as an
  // include/exclude source (INBOX/SENT/IMPORTANT/STARRED). Excludes noisy
  // system ones (SPAM, TRASH, DRAFT, CATEGORY_*, CHAT, UNREAD) that aren't
  // a real "channel" a user would toggle.
  const MEANINGFUL_SYSTEM_LABELS = new Set(["INBOX", "SENT", "IMPORTANT", "STARRED"]);
  const labels = (data.labels ?? []) as { id: string; name: string; type?: string }[];
  return labels
    .filter((l) => l.type === "user" || MEANINGFUL_SYSTEM_LABELS.has(l.id))
    .map((l) => ({ source: "gmail" as const, item_id: l.id, item_name: l.name }));
}

// Discord uses the one global bot token (see discord-oauth/index.ts's
// header comment for why), not a per-tenant access token - a separate
// function from fetchRealItems since its whole calling shape is
// different (guild_id + the global token, not accessToken alone).
const GUILD_TEXT_CHANNEL_TYPE = 0;
async function fetchDiscordChannels(guildId: string): Promise<RealItem[]> {
  if (!DISCORD_BOT_TOKEN) return [];
  const resp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  });
  if (!resp.ok) return [];
  const channels = (await resp.json()) as { id: string; type: number; name?: string }[];
  return channels
    .filter((c) => c.type === GUILD_TEXT_CHANNEL_TYPE)
    .map((c) => ({ source: "discord" as const, item_id: c.id, item_name: `#${c.name ?? c.id}` }));
}

// GitHub uses the App-level installation token (see _shared/githubAuth.ts's
// header comment), not a per-tenant access token - same reason this is a
// separate function from fetchRealItems as fetchDiscordChannels, just with
// installation_id + a freshly-minted token instead of a global bot token.
async function fetchGithubRepos(installationId: string): Promise<RealItem[]> {
  try {
    const token = await mintInstallationToken(installationId);
    const resp = await fetch("https://api.github.com/installation/repositories", {
      headers: githubApiHeaders(token),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const repos = (data.repositories ?? []) as { id: number; full_name: string }[];
    return repos.map((r) => ({ source: "github" as const, item_id: r.full_name, item_name: r.full_name }));
  } catch (err) {
    console.error("Failed to fetch GitHub repos:", err);
    return [];
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authorization = req.headers.get("Authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "");
  if (!token) {
    return jsonResponse({ error: "Authentication required" }, 401);
  }

  const supabase = getServiceClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return jsonResponse({ error: "Invalid or expired session" }, 401);
  }

  const { data: membership } = await supabase
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (!membership) {
    return jsonResponse({ error: "No tenant membership found" }, 403);
  }
  const tenantId = membership.tenant_id as string;
  const callerRole = membership.role as string;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const action = String(body.action ?? "");

  if (action === "list") {
    // Traced because this endpoint was slow and nothing measured it: the
    // provider fan-out and the two database reads are now separable in
    // request_traces rather than a single opaque wall-clock number.
    const trace = new Trace();
    const { data: sources } = await supabase
      .from("source_connections")
      .select("id, tenant_id, source, oauth_token_ref, external_workspace_id, cursor_state")
      .eq("tenant_id", tenantId)
      .eq("status", "active");
    trace.mark("load_connections");

    // Every connection here is a live third-party API call - Slack
    // conversations.list, Notion search, Gmail labels, Jira projects,
    // Confluence spaces, Discord channels, GitHub repos, Monday boards,
    // ClickUp spaces - and they were awaited one after another, so opening
    // Build Memory cost the SUM of every connected provider's response
    // time. Nine connectors meant nine round trips in series. They don't
    // depend on each other, so they now run together and the page costs the
    // slowest single provider instead of all of them added up.
    const connections = sources ?? [];
    const perConnection = await Promise.all(connections.map(async (row) => {
      const source = row.source as Source;
      try {
        if (source === "jira" || source === "confluence") {
          // Atlassian access tokens expire in ~1h - refresh unconditionally
          // before use, same as jira-poller/confluence-poller already do,
          // since this Settings page could be opened well after the last
          // background poll refreshed it.
          const refreshed = await refreshAtlassianAccess({
            id: row.id as string,
            tenant_id: row.tenant_id as string,
            oauth_token_ref: row.oauth_token_ref as string | null,
            cursor_state: row.cursor_state as AtlassianConnection["cursor_state"],
          });
          if (!refreshed) return [];
          return await fetchRealItems(source, refreshed.accessToken, refreshed.cloudId);
        }
        if (source === "discord") {
          return await fetchDiscordChannels(row.external_workspace_id as string);
        }
        if (source === "teams") {
          // The one source with no provider call to make. Graph has no
          // "which channels may this app see" endpoint - with
          // ChannelMessage.Read.All the answer is all of them - so the
          // list is built from channels Locus has actually heard from,
          // recorded by teams-webhook as messages arrive.
          //
          // Honest consequence: a channel appears here after its first
          // captured message, not at connect time. Every other source is
          // complete the moment it is connected.
          const channels =
            (row.cursor_state as { channels?: Record<string, { name?: string | null; team?: string | null }> } | null)
              ?.channels ?? {};
          return Object.entries(channels).map(([itemId, info]) => {
            const channelName = info?.name ?? "General";
            return {
              source: "teams" as Source,
              item_id: itemId,
              item_name: info?.team ? `${info.team} / ${channelName}` : channelName,
            };
          });
        }
        if (source === "github") {
          const installationId = (row.cursor_state as { installation_id?: number } | null)?.installation_id;
          if (!installationId) return [];
          return await fetchGithubRepos(String(installationId));
        }
        const accessToken = await decryptToken(row.oauth_token_ref as string | null);
        if (!accessToken) return [];
        // ClickUp's team_id lives in external_workspace_id, reused
        // through the same "extra per-connection id" param Jira/
        // Confluence already pass their cloudId through - no need for
        // a new parameter just for this source.
        return await fetchRealItems(source, accessToken, row.external_workspace_id as string | undefined);
      } catch (err) {
        // One provider being down or slow must not blank out the other
        // eight - the same per-connection isolation the sequential version
        // had, kept deliberately: Promise.all would otherwise reject the
        // whole list on a single failure.
        console.error(`Failed to fetch real items for ${source}:`, err);
        return [] as RealItem[];
      }
    }));

    // A tenant can have more than one active connection for the same
    // source (e.g. two Gmail accounts) - dedupe by (source, item_id) so the
    // same channel/page/label/project/space fetched from multiple
    // connections doesn't show up multiple times. Applied in connection
    // order rather than completion order, so which duplicate wins stays
    // exactly what it was before these ran concurrently.
    const itemsByKey = new Map<string, RealItem>();
    for (const items of perConnection) {
      for (const item of items) {
        itemsByKey.set(`${item.source}:${item.item_id}`, item);
      }
    }
    const realItems = Array.from(itemsByKey.values());
    trace.mark("fetch_provider_items");

    const { data: rules, error: rulesError } = await supabase
      .from("capture_source_rules")
      .select("source, item_id, included")
      .eq("tenant_id", tenantId);

    if (rulesError) {
      console.error("Failed to load capture_source_rules:", rulesError);
      return jsonResponse({ error: "Unable to load capture source rules" }, 500);
    }

    const ruleMap = new Map<string, boolean>();
    for (const rule of rules ?? []) {
      ruleMap.set(`${rule.source}:${rule.item_id}`, rule.included as boolean);
    }

    const items = realItems.map((item) => ({
      ...item,
      included: ruleMap.get(`${item.source}:${item.item_id}`) ?? true,
    }));

    trace.mark("load_rules_and_build");
    void trace.write(tenantId, "POST capture-source-rules:list");

    return jsonResponse({ items }, 200);
  }

  if (action === "toggle") {
    const source = String(body.source ?? "");
    const itemId = String(body.item_id ?? "");
    const itemName = String(body.item_name ?? "");
    const included = Boolean(body.included);

    if (!source || !itemId) {
      return jsonResponse({ error: "source and item_id are required" }, 400);
    }

    const { error } = await supabase.from("capture_source_rules").upsert(
      {
        tenant_id: tenantId,
        source,
        item_id: itemId,
        item_name: itemName,
        included,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,source,item_id" },
    );

    if (error) {
      console.error("Failed to update capture_source_rules:", error);
      return jsonResponse({ error: "Unable to update capture rule" }, 500);
    }
    return jsonResponse({ included }, 200);
  }

  if (action === "disconnect") {
    const connectionId = String(body.connection_id ?? "");
    const deleteHistory = Boolean(body.delete_history);
    if (!connectionId) {
      return jsonResponse({ error: "connection_id is required" }, 400);
    }

    // Real bug this closes: any tenant member could disconnect ANY other
    // member's connection, with nothing distinguishing "mine" from
    // "theirs" - only the person who connected it, or a workspace
    // owner/admin, can disconnect it. connected_by null (every row that
    // predates this column) is treated as still-manageable-by-anyone, same
    // as before this check existed - it never locks out a legacy
    // connection nobody can prove ownership of.
    const { data: target } = await supabase
      .from("source_connections")
      .select("connected_by")
      .eq("id", connectionId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!target) {
      return jsonResponse({ error: "Connection not found" }, 404);
    }
    if (
      target.connected_by &&
      target.connected_by !== user.id &&
      callerRole === "member"
    ) {
      return jsonResponse({
        error: "Only the person who connected this, or a workspace owner/admin, can disconnect it",
      }, 403);
    }

    // Revoke first, unconditionally - stops new ingestion immediately
    // regardless of whether the history deletion below succeeds.
    const { data: revokedRows, error: revokeError } = await supabase
      .from("source_connections")
      .update({ status: "revoked" })
      .eq("id", connectionId)
      .eq("tenant_id", tenantId)
      .select("id, source");

    if (revokeError) {
      console.error("Failed to revoke source_connections row:", revokeError);
      return jsonResponse({ error: "Unable to disconnect" }, 500);
    }
    if (!revokedRows || revokedRows.length === 0) {
      return jsonResponse({ error: "Connection not found" }, 404);
    }

    if (deleteHistory) {
      const { data: rawEventRows, error: rawEventsError } = await supabase
        .from("raw_events")
        .select("id, source_id")
        .eq("connection_id", connectionId)
        .eq("tenant_id", tenantId);

      if (rawEventsError) {
        console.error("Failed to look up raw_events for deletion:", rawEventsError);
        return jsonResponse({ error: "Disconnected, but could not delete history" }, 500);
      }

      const rawEventIds = (rawEventRows ?? []).map((row) => row.id as string);
      if (rawEventIds.length > 0) {
        // decision_actors/decision_sources/decision_embeddings/
        // decision_conflicts all cascade off decisions(id) - only decisions
        // and raw_events themselves need an explicit delete.
        const { error: decisionsError } = await supabase
          .from("decisions")
          .delete()
          .eq("tenant_id", tenantId)
          .in("origin_raw_event_id", rawEventIds);
        if (decisionsError) {
          console.error("Failed to delete decisions for connection:", decisionsError);
          return jsonResponse({ error: "Disconnected, but could not delete every captured decision" }, 500);
        }

        const { error: rawDeleteError } = await supabase
          .from("raw_events")
          .delete()
          .eq("tenant_id", tenantId)
          .in("id", rawEventIds);
        if (rawDeleteError) {
          console.error("Failed to delete raw_events for connection:", rawDeleteError);
          return jsonResponse({ error: "Disconnected, but could not delete every raw message" }, 500);
        }
      }
    }

    return jsonResponse({ success: true }, 200);
  }

  if (action === "get_memory_mode") {
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("learning_paused, core_knowledge_only")
      .eq("id", tenantId)
      .single();

    if (tenantError || !tenant) {
      console.error("Failed to load tenant memory mode:", tenantError);
      return jsonResponse({ error: "Unable to load memory mode" }, 500);
    }

    return jsonResponse({
      learning_paused: Boolean(tenant.learning_paused),
      core_knowledge_only: Boolean(tenant.core_knowledge_only),
    }, 200);
  }

  if (action === "set_memory_mode") {
    const update: Record<string, boolean> = {};
    if (typeof body.learning_paused === "boolean") update.learning_paused = body.learning_paused;
    if (typeof body.core_knowledge_only === "boolean") update.core_knowledge_only = body.core_knowledge_only;
    if (Object.keys(update).length === 0) {
      return jsonResponse({ error: "learning_paused and/or core_knowledge_only (boolean) required" }, 400);
    }

    const { error: updateError } = await supabase
      .from("tenants")
      .update(update)
      .eq("id", tenantId);

    if (updateError) {
      console.error("Failed to update tenant memory mode:", updateError);
      return jsonResponse({ error: "Unable to update memory mode" }, 500);
    }

    return jsonResponse({ success: true, ...update }, 200);
  }

  return jsonResponse({ error: `Unknown action: ${action}` }, 400);
});
