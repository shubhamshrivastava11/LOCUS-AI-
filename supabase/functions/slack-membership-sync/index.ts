// supabase/functions/slack-membership-sync/index.ts
//
// Populates public.source_scope_members so the permission check has real
// data to consult instead of guessing.
//
// The gap this closes: isDecisionAccessible() used to end
// `return decision.permission_scope.every(isUnmappedScope)` - a decision
// scoped to a Slack channel id nobody had membership data for was granted
// to EVERY member of the tenant. There was no table saying who is actually
// in a channel, so it guessed generously. This fills that table.
//
// Emails, not Slack user ids, are what gets stored: resolvePermissionScopes
// (_shared/tenantAuth.ts) returns workspace ids plus the caller's own login
// email, so email is the only identifier the comparison can match on.
// Resolving them needs the users:read.email scope - tokens issued before
// that scope was added to slack-oauth simply won't have it, which is
// handled as a skip-with-a-log rather than a failure (see SCOPE_ERRORS).
//
// Runs cross-tenant on a schedule, NOT once: a stale membership cache would
// recreate exactly the staleness problem this product exists to solve.
//
// Deploy note: --no-verify-jwt, same as every other cron-driven function.

import { withAdmin, withTenant } from "../_shared/db.ts";
import { decryptToken } from "../_shared/tokenCrypto.ts";

console.log("Slack membership sync started!");

const REQUEST_TIMEOUT_MS = 20_000;
// Slack's conversations.members / users.info sit in the tier that allows
// roughly 100 requests a minute. These bounds keep one run comfortably
// inside that and inside Supabase's own 150s function ceiling; anything
// left over is picked up on the next scheduled run rather than racing.
const MAX_CHANNELS_PER_CONNECTION = 60;
const MAX_MEMBER_PAGES = 5;

const SCOPE_ERRORS = new Set(["missing_scope", "not_allowed_token_type", "invalid_auth", "account_inactive"]);

type SlackConnection = {
  id: string;
  tenant_id: string;
  oauth_token_ref: string | null;
  external_workspace_id: string | null;
};

async function slackGet(
  token: string, method: string, params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Every channel the bot is actually in - membership of a channel it can't see is unknowable. */
async function listChannels(token: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor = "";
  for (let page = 0; page < 3; page++) {
    const data = await slackGet(token, "conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });
    if (!data.ok) {
      const err = String(data.error ?? "unknown");
      if (SCOPE_ERRORS.has(err)) throw new Error(`scope:${err}`);
      break;
    }
    for (const ch of (data.channels ?? []) as { id: string; is_member?: boolean }[]) {
      if (ch.is_member) ids.push(ch.id);
    }
    cursor = String((data.response_metadata as { next_cursor?: string })?.next_cursor ?? "");
    if (!cursor) break;
  }
  return ids.slice(0, MAX_CHANNELS_PER_CONNECTION);
}

async function listChannelMembers(token: string, channelId: string): Promise<string[]> {
  const users: string[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
    const data = await slackGet(token, "conversations.members", {
      channel: channelId, limit: "200", ...(cursor ? { cursor } : {}),
    });
    if (!data.ok) {
      const err = String(data.error ?? "unknown");
      if (SCOPE_ERRORS.has(err)) throw new Error(`scope:${err}`);
      break;
    }
    users.push(...((data.members ?? []) as string[]));
    cursor = String((data.response_metadata as { next_cursor?: string })?.next_cursor ?? "");
    if (!cursor) break;
  }
  return users;
}

/**
 * Slack user id -> email. Cached for the whole run: the same people appear
 * in many channels, and users.info is the most-called endpoint here by far.
 * A user with no email (bots, apps, restricted accounts) is cached as null
 * so it's never looked up twice.
 */
async function buildEmailResolver(token: string) {
  const cache = new Map<string, string | null>();
  return async (userId: string): Promise<string | null> => {
    if (cache.has(userId)) return cache.get(userId) ?? null;
    const data = await slackGet(token, "users.info", { user: userId });
    let email: string | null = null;
    if (data.ok) {
      const user = data.user as { profile?: { email?: string }; is_bot?: boolean } | undefined;
      if (!user?.is_bot) email = user?.profile?.email ?? null;
    } else if (SCOPE_ERRORS.has(String(data.error ?? ""))) {
      throw new Error(`scope:${data.error}`);
    }
    cache.set(userId, email);
    return email;
  };
}

async function syncConnection(conn: SlackConnection): Promise<{ channels: number; members: number }> {
  if (!conn.oauth_token_ref) return { channels: 0, members: 0 };
  const token = await decryptToken(conn.oauth_token_ref);
  // An undecryptable token contributes no membership data rather than
  // throwing the whole run - the scopes it owns just stay permissive.
  if (!token) return { channels: 0, members: 0 };

  const channels = await listChannels(token);
  const resolveEmail = await buildEmailResolver(token);

  let memberRows = 0;
  for (const channelId of channels) {
    const userIds = await listChannelMembers(token, channelId);
    const emails: string[] = [];
    for (const uid of userIds) {
      const email = await resolveEmail(uid);
      if (email) emails.push(email.toLowerCase());
    }

    // Replace this channel's membership wholesale rather than merging:
    // someone REMOVED from a channel has to actually lose access, and a
    // pure upsert would leave their row behind forever. Both statements
    // run in the one withTenant transaction, so the channel is never
    // momentarily empty for a concurrent reader.
    await withTenant(conn.tenant_id, async (sql) => {
      await sql`
        delete from public.source_scope_members
        where tenant_id = ${conn.tenant_id}::uuid and source = 'slack' and external_scope_id = ${channelId}
      `;
      if (emails.length > 0) {
        await sql`
          insert into public.source_scope_members (tenant_id, source, external_scope_id, member_email)
          select ${conn.tenant_id}::uuid, 'slack', ${channelId}, unnest(${emails}::text[])
          on conflict do nothing
        `;
      }
    });
    memberRows += emails.length;
  }

  return { channels: channels.length, members: memberRows };
}

Deno.serve(async (_req: Request) => {
  const started = Date.now();
  const summary: Record<string, unknown>[] = [];

  try {
    const connections = await withAdmin(async (sql) => {
      return await sql`
        select id, tenant_id, oauth_token_ref, external_workspace_id
        from public.source_connections
        where source = 'slack' and status = 'active' and oauth_token_ref is not null
      `;
    }) as unknown as SlackConnection[];

    for (const conn of connections) {
      try {
        const result = await syncConnection(conn);
        summary.push({ connection: conn.id, workspace: conn.external_workspace_id, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith("scope:")) {
          // A token predating the users:read.email / channels:read scopes.
          // Skipped, not failed - that connection simply contributes no
          // membership data, and every scope it owns keeps the old
          // permissive behaviour until someone reconnects it.
          console.warn(`connection ${conn.id} lacks required Slack scopes (${message}) - skipped`);
          summary.push({ connection: conn.id, skipped: message });
        } else {
          console.error(`connection ${conn.id} sync failed:`, err);
          summary.push({ connection: conn.id, error: message });
        }
      }
    }

    return new Response(
      JSON.stringify({ synced: summary, elapsed_ms: Date.now() - started }, null, 2),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("slack-membership-sync failed:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
