// supabase/functions/monday-oauth/index.ts
//
// Standard per-tenant OAuth, same shape as Notion (not Jira/Confluence's
// refresh-token dance, not GitHub's App-installation model) - verified
// against Monday's own docs before writing this: access tokens "do not
// expire and are valid until the user uninstalls your app... OAuth flow
// does not support refresh tokens." So oauth_token_ref just gets stored
// once and reused indefinitely, same as notion-oauth.
//
// Scopes (boards:read, updates:read, me:read) are configured on the app
// itself in Monday's Developer Center, not passed as a `scope` query
// param on the authorize redirect - confirmed via Monday's own docs,
// which describe scope configuration as a separate OAuth-tab setup step,
// closer to GitHub App's app-configured-permissions model than Slack's
// classic query-string scope. No scope param is sent here on purpose.
//
// Monday's OAuth token response doesn't include a workspace/account name
// inline the way Notion's does - a follow-up GraphQL `me { account }`
// call resolves a real display name post-exchange.

import { withTenant } from "../_shared/db.ts";
import { ensureSourceConnectionDisplayNameColumn } from "../_shared/sourceConnectionSchema.ts";
import {
  authorizeErrorResponse,
  encodeState,
  parseTenantState,
  popupCallbackResponse,
  resolveRedirectOrigin,
  resolveTenantFromAuthorize,
} from "../_shared/oauth_tenant.ts";
import { encryptToken } from "../_shared/tokenCrypto.ts";
import { enforceRouteRateLimit } from "../_shared/routeRateLimit.ts";

console.log("Monday OAuth handler started!");

const CLIENT_ID = Deno.env.get("MONDAY_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("MONDAY_CLIENT_SECRET");
const REDIRECT_URI = Deno.env.get("MONDAY_REDIRECT_URI");

const SOURCE = "monday" as const;

// Deploy note: this function must ALWAYS be deployed with --no-verify-jwt.
// See slack-oauth/index.ts's identical comment for why.
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/authorize")) {
    const redirectOrigin = resolveRedirectOrigin(url);
    try {
      const { tenantId, userId } = await resolveTenantFromAuthorize(url);
      await enforceRouteRateLimit(tenantId, "monday-oauth");

      const authorizeUrl = new URL("https://auth.monday.com/oauth2/authorize");
      authorizeUrl.searchParams.set("client_id", CLIENT_ID ?? "");
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI ?? "");
      authorizeUrl.searchParams.set("state", encodeState(tenantId, userId, redirectOrigin));

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
      ({ tenantId, userId, redirectOrigin } = parseTenantState(url.searchParams.get("state")));
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
      const tokenResponse = await fetch("https://auth.monday.com/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          redirect_uri: REDIRECT_URI ?? "",
        }),
      });
      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || tokenData.error) {
        return popupCallbackResponse(SOURCE, {
          success: false,
          error: `Monday OAuth failed: ${tokenData.error ?? tokenData.error_description ?? "unknown error"}`,
          status: 400,
        }, redirectOrigin);
      }

      // Real gotcha, verified against Monday's own docs before writing
      // this: the Authorization header takes the raw token, no "Bearer "
      // prefix - every other connector here uses Bearer, this one
      // doesn't.
      //
      // Deliberately not querying `account` for a real workspace/company
      // name - verified live that it needs its own account:read scope,
      // separate from me:read, which Step 1's guidance never asked for.
      // Rather than send the user back to add a scope after the app's
      // already created, the connecting user's own name (covered by
      // me:read, already granted) is a perfectly good display label.
      const meResp = await fetch("https://api.monday.com/v2", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: tokenData.access_token },
        body: JSON.stringify({ query: "query { me { id name } }" }),
      });
      const meData = await meResp.json();
      const me = meData?.data?.me as { id?: number; name?: string } | undefined;

      const lastSyncedAt = null;

      // external_workspace_id is the connecting user's own id, not a
      // workspace/account id (see the account:read scope note above) -
      // a real, deliberate semantic difference from every other
      // connector here, which key on the actual team/site/workspace.
      // Consistent with how Monday's OAuth tokens work in the first
      // place (per-user, not one workspace-wide installation like
      // Slack's bot token) - two teammates each connecting their own
      // Monday login is two separate rows, same as two Gmail accounts,
      // not a bug.
      try {
        const encryptedToken = await encryptToken(tokenData.access_token);
        await ensureSourceConnectionDisplayNameColumn();
        await withTenant(tenantId, async (sql) => {
          await sql`
            insert into public.source_connections (
              tenant_id, source, external_workspace_id, display_name, oauth_token_ref,
              ingestion_mode, status, cursor_state, last_synced_at, connected_by
            ) values (
              ${tenantId}::uuid,
              'monday',
              ${me?.id ? String(me.id) : "unknown"},
              ${me?.name ?? null},
              ${encryptedToken},
              'polling',
              'active',
              '{}'::jsonb,
              ${lastSyncedAt},
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return popupCallbackResponse(SOURCE, {
          success: false,
          error: `Failed to store token: ${message}`,
          status: 500,
        }, redirectOrigin);
      }

      return popupCallbackResponse(SOURCE, { success: true }, redirectOrigin);
    } catch (error) {
      console.error("Monday OAuth error:", error);
      return popupCallbackResponse(SOURCE, {
        success: false,
        error: "Internal Server Error",
        status: 500,
      }, redirectOrigin);
    }
  }

  return new Response("Not found", { status: 404 });
});
