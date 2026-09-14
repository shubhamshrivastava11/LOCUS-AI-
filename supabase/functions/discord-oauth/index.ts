// supabase/functions/discord-oauth/index.ts
//
// Architecturally different from every other connector here. Slack/Gmail/
// Notion/Jira/Confluence all use per-tenant OAuth - each customer's own
// consent grants US a token scoped to THEIR workspace, stored encrypted
// in oauth_token_ref. Discord doesn't work that way for reading messages:
// there's ONE bot (owned by Locus AI, DISCORD_BOT_TOKEN - a global
// secret, not per-tenant), and a customer "connects" by inviting that
// SAME bot into their own server. Reading messages afterward always uses
// the one global bot token, never a per-tenant one - oauth_token_ref
// stays null for every Discord source_connections row, on purpose.
//
// Pure `scope=bot` is Discord's own "callback-less" flow (no redirect_uri,
// no way to learn which guild was picked) - only useful for a bare invite
// link. Getting guild_id back on our own callback requires adding a
// second scope (identify - not used for anything else here) to force the
// full authorization-code flow, which DOES redirect with guild_id +
// permissions as query params. No token exchange needed at all: we only
// wanted the callback to fire with guild_id, never the user's own access
// token, so `code` is read and discarded, not exchanged.

import { withTenant } from "../_shared/db.ts";
import { ensureSourceConnectionDisplayNameColumn } from "../_shared/sourceConnectionSchema.ts";
import {
  authorizeErrorResponse,
  createOAuthState,
  consumeOAuthState,
  popupCallbackResponse,
  resolveRedirectOrigin,
  resolveTenantFromAuthorize,
} from "../_shared/oauth_tenant.ts";
import { enforceRouteRateLimit } from "../_shared/routeRateLimit.ts";

// Deploy note: this function must ALWAYS be deployed with --no-verify-jwt.
// See slack-oauth/index.ts's identical comment for why.

console.log("Discord OAuth handler started!");

const CLIENT_ID = Deno.env.get("DISCORD_CLIENT_ID");
const BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN");
const REDIRECT_URI = Deno.env.get("DISCORD_REDIRECT_URI");

const SOURCE = "discord" as const;
// View Channels (0x400) + Read Message History (0x10000) - read-only,
// matching every other connector's minimal-scope philosophy. No Send
// Messages, no Manage anything.
const BOT_PERMISSIONS = "66560";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/authorize")) {
    const redirectOrigin = resolveRedirectOrigin(url);
    try {
      const { tenantId, userId } = await resolveTenantFromAuthorize(url);
      await enforceRouteRateLimit(tenantId, "discord-oauth");

      const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
      authorizeUrl.searchParams.set("client_id", CLIENT_ID ?? "");
      authorizeUrl.searchParams.set("scope", "bot identify");
      authorizeUrl.searchParams.set("permissions", BOT_PERMISSIONS);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI ?? "");
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("state", await createOAuthState(tenantId, userId, SOURCE, redirectOrigin));

      return Response.redirect(authorizeUrl.toString(), 302);
    } catch (err) {
      return authorizeErrorResponse(SOURCE, err, redirectOrigin);
    }
  }

  if (url.pathname.endsWith("/callback")) {
    let tenantId: string;
    let userId: string;
    let redirectOrigin: string;
    try {
      ({ tenantId, userId, redirectOrigin } = await consumeOAuthState(url.searchParams.get("state"), SOURCE));
    } catch (err) {
      return authorizeErrorResponse(SOURCE, err, resolveRedirectOrigin(url));
    }

    // guild_id/permissions arrive directly on the redirect - no token
    // exchange needed, `code` (the user's own access grant, from the
    // `identify` scope forcing this full flow) is never used for anything.
    const guildId = url.searchParams.get("guild_id");
    if (!guildId) {
      return popupCallbackResponse(SOURCE, {
        success: false,
        error: "Missing guild_id - the server invite may have been cancelled",
        status: 400,
      }, redirectOrigin);
    }

    try {
      // Best-effort real server name for display_name - a failure here
      // shouldn't block the connection itself, the guild_id is already
      // enough to work.
      let guildName: string | null = null;
      if (BOT_TOKEN) {
        try {
          const guildResp = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
            headers: { Authorization: `Bot ${BOT_TOKEN}` },
          });
          if (guildResp.ok) {
            const guildData = await guildResp.json();
            guildName = typeof guildData.name === "string" ? guildData.name : null;
          }
        } catch {
          // Best-effort only.
        }
      }

      await ensureSourceConnectionDisplayNameColumn();
      await withTenant(tenantId, async (sql) => {
        await sql`
          insert into public.source_connections (
            tenant_id, source, external_workspace_id, display_name, oauth_token_ref,
            ingestion_mode, status, cursor_state, last_synced_at, connected_by
          ) values (
            ${tenantId}::uuid,
            'discord',
            ${guildId},
            ${guildName},
            null,
            'polling',
            'active',
            '{}'::jsonb,
            null,
            ${userId || null}::uuid
          )
          on conflict (tenant_id, source, external_workspace_id)
          do update set
            display_name = excluded.display_name,
            status = 'active',
            connected_by = excluded.connected_by
        `;
      });

      return popupCallbackResponse(SOURCE, { success: true }, redirectOrigin);
    } catch (error) {
      console.error("Discord OAuth error:", error);
      return popupCallbackResponse(SOURCE, {
        success: false,
        error: "Internal Server Error",
        status: 500,
      }, redirectOrigin);
    }
  }

  return new Response("Not found", { status: 404 });
});
