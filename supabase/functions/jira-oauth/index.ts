// supabase/functions/jira-oauth/index.ts
//
// Jira Cloud OAuth 2.0 (3LO), Resource-level access type - grants access
// only to the one site the user selects during consent, matching how
// Slack/Notion/Gmail already work (one explicit workspace per connection,
// never blanket access across everything under one identity). Shares one
// Atlassian app (ATLASSIAN_CLIENT_ID/ATLASSIAN_CLIENT_SECRET) with
// confluence-oauth - Atlassian's own OAuth allows requesting scopes from
// multiple products in one app, this just uses it for two products
// instead of one, matching this codebase's one-Edge-Function-per-source
// convention rather than merging Jira and Confluence into one function.
//
// Access tokens are short-lived (~1h) - offline_access is requested so a
// refresh_token comes back too, stored in cursor_state (unencrypted,
// matching gmail-oauth's own precedent for its refresh_token) alongside
// the resolved cloud_id every Jira API call needs
// (https://api.atlassian.com/ex/jira/{cloud_id}/...). Actually using that
// refresh_token to keep the connection alive is poller work, not part of
// getting the connection established - not built here.

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

console.log("Jira OAuth handler started!");

const CLIENT_ID = Deno.env.get("ATLASSIAN_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("ATLASSIAN_CLIENT_SECRET");
const REDIRECT_URI = Deno.env.get("JIRA_REDIRECT_URI");

const SOURCE = "jira" as const;
const SCOPES = "read:jira-work offline_access";

interface AccessibleResource {
  id: string;
  url: string;
  name: string;
  scopes: string[];
}

// Deploy note: this function must ALWAYS be deployed with --no-verify-jwt.
// See slack-oauth/index.ts's identical comment for why - this exact bug
// was hit live on this function's first deploy (missing the flag), fixed
// on redeploy, and this comment is the reason it shouldn't happen again.
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // GET /authorize: redirect to Atlassian's consent screen
  if (url.pathname.endsWith("/authorize")) {
    const redirectOrigin = resolveRedirectOrigin(url);
    const syncMode = url.searchParams.get("sync_mode") === "new" ? "new" : "full";
    try {
      const { tenantId, userId } = await resolveTenantFromAuthorize(url);
      await enforceRouteRateLimit(tenantId, "jira-oauth");

      const authorizeUrl = new URL("https://auth.atlassian.com/authorize");
      authorizeUrl.searchParams.set("audience", "api.atlassian.com");
      authorizeUrl.searchParams.set("client_id", CLIENT_ID ?? "");
      authorizeUrl.searchParams.set("scope", SCOPES);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI ?? "");
      authorizeUrl.searchParams.set("state", await createOAuthState(tenantId, userId, SOURCE, redirectOrigin, syncMode));
      authorizeUrl.searchParams.set("response_type", "code");
      // Always show the consent screen, even for a user who's already
      // granted this app access before - a stale silent re-auth could
      // otherwise hand back a token scoped to a DIFFERENT site than the
      // one they mean to connect this time (Resource-level access type
      // asks which site on every real consent).
      authorizeUrl.searchParams.set("prompt", "consent");

      return Response.redirect(authorizeUrl.toString(), 302);
    } catch (err) {
      return authorizeErrorResponse(SOURCE, err, redirectOrigin);
    }
  }

  // GET /callback: exchange code, resolve the granted site, store the connection
  if (url.pathname.endsWith("/callback")) {
    let tenantId: string;
    let userId: string;
    let redirectOrigin: string;
    let syncMode: "full" | "new";
    try {
      ({ tenantId, userId, redirectOrigin, syncMode } = await consumeOAuthState(url.searchParams.get("state"), SOURCE));
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
      const tokenResponse = await fetch("https://auth.atlassian.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
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
          error: `Jira OAuth failed: ${tokenData.error ?? tokenData.error_description ?? "unknown error"}`,
          status: 400,
        }, redirectOrigin);
      }

      // Resource-level access -> exactly one site for a real single-site
      // grant. Still handling "more than one" defensively (take the
      // first) rather than assuming the array always has length 1 - the
      // access-type restriction is enforced by Atlassian's consent UI,
      // not something this code should trust blindly from a raw API
      // response.
      const resourcesResp = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/json" },
      });
      const resources = await resourcesResp.json() as AccessibleResource[];
      if (!resourcesResp.ok || !Array.isArray(resources) || resources.length === 0) {
        return popupCallbackResponse(SOURCE, {
          success: false,
          error: "No accessible Jira site granted",
          status: 400,
        }, redirectOrigin);
      }
      const site = resources[0];

      const lastSyncedAt = syncMode === "new" ? new Date().toISOString() : null;

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
              'jira',
              ${site.id},
              ${site.name},
              ${encryptedToken},
              'polling',
              'active',
              ${sql.json({
                refresh_token: tokenData.refresh_token ?? null,
                cloud_id: site.id,
                site_url: site.url,
              })},
              ${lastSyncedAt},
              ${userId || null}::uuid
            )
            on conflict (tenant_id, source, external_workspace_id)
            do update set
              oauth_token_ref = excluded.oauth_token_ref,
              display_name = excluded.display_name,
              status = 'active',
              cursor_state = excluded.cursor_state,
              ingestion_mode = excluded.ingestion_mode,
              last_synced_at = excluded.last_synced_at,
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
      console.error("Jira OAuth error:", error);
      return popupCallbackResponse(SOURCE, {
        success: false,
        error: "Internal Server Error",
        status: 500,
      }, redirectOrigin);
    }
  }

  return new Response("Not found", { status: 404 });
});
