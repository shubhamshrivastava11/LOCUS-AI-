// supabase/functions/clickup-oauth/index.ts
//
// Standard per-tenant OAuth, same never-expiring-token shape as Notion/
// Monday - verified against ClickUp's own docs before writing this:
// "The access token currently does not expire." No refresh token
// mechanism exists.
//
// Real, disclosed limitation verified against ClickUp's own docs (and a
// second independent source) before building this: ClickUp has no OAuth
// scope system at all. Every connection gets full read+write access
// matching whatever the authorizing person can already do in their
// workspace - there is no way to request read-only, unlike GitHub (where
// a GitHub App made true read-only possible) or Jira (Resource-level
// access restricted to one site). Locus AI's own code never calls a
// write endpoint, but the grant itself is broader than that in principle
// - a real platform limitation, not something this codebase can
// architect around, confirmed with the user before building.
//
// A user can authorize more than one Workspace ("team" in ClickUp's own
// API vocabulary) in a single grant - one source_connections row gets
// created per authorized team, not just the first one, unlike Jira's
// "take the first" precedent (Jira's Resource-level access type
// structurally only ever grants one site; ClickUp's doesn't have that
// restriction).

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
import { encryptToken } from "../_shared/tokenCrypto.ts";
import { enforceRouteRateLimit } from "../_shared/routeRateLimit.ts";

console.log("ClickUp OAuth handler started!");

const CLIENT_ID = Deno.env.get("CLICKUP_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("CLICKUP_CLIENT_SECRET");
const REDIRECT_URI = Deno.env.get("CLICKUP_REDIRECT_URI");

const SOURCE = "clickup" as const;

interface ClickUpTeam {
  id: string;
  name?: string;
}

// Deploy note: this function must ALWAYS be deployed with --no-verify-jwt.
// See slack-oauth/index.ts's identical comment for why.
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/authorize")) {
    const redirectOrigin = resolveRedirectOrigin(url);
    try {
      const { tenantId, userId } = await resolveTenantFromAuthorize(url);
      await enforceRouteRateLimit(tenantId, "clickup-oauth");

      const authorizeUrl = new URL("https://app.clickup.com/api");
      authorizeUrl.searchParams.set("client_id", CLIENT_ID ?? "");
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI ?? "");
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

    const code = url.searchParams.get("code");
    if (!code) {
      return popupCallbackResponse(SOURCE, {
        success: false,
        error: "Missing authorization code",
        status: 400,
      }, redirectOrigin);
    }

    try {
      const tokenResponse = await fetch("https://api.clickup.com/api/v2/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
      });
      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || tokenData.err) {
        return popupCallbackResponse(SOURCE, {
          success: false,
          error: `ClickUp OAuth failed: ${tokenData.err ?? "unknown error"}`,
          status: 400,
        }, redirectOrigin);
      }

      const teamsResp = await fetch("https://api.clickup.com/api/v2/team", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const teamsData = await teamsResp.json();
      const teams = (teamsData.teams ?? []) as ClickUpTeam[];

      if (!teamsResp.ok || teams.length === 0) {
        return popupCallbackResponse(SOURCE, {
          success: false,
          error: "No ClickUp Workspace authorized for this account",
          status: 400,
        }, redirectOrigin);
      }

      const encryptedToken = await encryptToken(tokenData.access_token);
      await ensureSourceConnectionDisplayNameColumn();

      // One row per authorized team - a single grant can cover more than
      // one Workspace, unlike Jira's Resource-level access type which
      // structurally only ever returns one site.
      for (const team of teams) {
        await withTenant(tenantId, async (sql) => {
          await sql`
            insert into public.source_connections (
              tenant_id, source, external_workspace_id, display_name, oauth_token_ref,
              ingestion_mode, status, cursor_state, last_synced_at, connected_by
            ) values (
              ${tenantId}::uuid,
              'clickup',
              ${team.id},
              ${team.name ?? null},
              ${encryptedToken},
              'polling',
              'active',
              '{}'::jsonb,
              null,
              ${userId || null}::uuid
            )
            on conflict (tenant_id, source, external_workspace_id)
            do update set
              oauth_token_ref = excluded.oauth_token_ref,
              display_name = excluded.display_name,
              status = 'active',
              connected_by = excluded.connected_by
          `;
        });
      }

      return popupCallbackResponse(SOURCE, { success: true }, redirectOrigin);
    } catch (error) {
      console.error("ClickUp OAuth error:", error);
      return popupCallbackResponse(SOURCE, {
        success: false,
        error: "Internal Server Error",
        status: 500,
      }, redirectOrigin);
    }
  }

  return new Response("Not found", { status: 404 });
});
