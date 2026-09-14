// supabase/functions/github-oauth/index.ts
//
// GitHub App user-to-server OAuth, used only to discover which
// installation the authorizing user has access to - not to establish a
// long-lived per-tenant token the way Slack/Notion/Jira/Confluence do.
// The user access token minted here is used exactly once (the
// GET /user/installations call below) and then discarded - never stored,
// never encrypted, never refreshed. All real API reads later go through
// _shared/githubAuth.ts's App-level JWT -> installation access token
// exchange instead, using only the installation_id persisted here.
//
// Deliberately NOT using GitHub's "setup URL" installation redirect
// (https://github.com/apps/<slug>/installations/new) as the primary flow,
// even though it's the more obvious "Connect" button target - GitHub's
// own docs warn its installation_id query param can be spoofed by a bad
// actor hitting the URL directly, and it does not reliably carry a
// `state` param through the redirect (confirmed via GitHub community
// reports, not just assumed). The standard user OAuth flow below reuses
// this codebase's own createOAuthState/consumeOAuthState round trip instead,
// which is what every other connector's tenant-resolution security
// already rests on - GitHub Apps support this same flow via
// https://github.com/login/oauth/authorize, no `scope` param needed
// (permissions are defined entirely by the App's own configured
// permissions + which installation the user has access to, not a scope
// string like classic OAuth Apps use).
//
// If the user hasn't installed the App on any org/repo yet,
// GET /user/installations comes back empty - the callback reports that
// as an error pointing at the install URL rather than silently creating
// a connection with no installation_id to poll.

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

console.log("GitHub OAuth handler started!");

const CLIENT_ID = Deno.env.get("GITHUB_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("GITHUB_CLIENT_SECRET");
const REDIRECT_URI = Deno.env.get("GITHUB_REDIRECT_URI");
const APP_SLUG = Deno.env.get("GITHUB_APP_SLUG");

const SOURCE = "github" as const;

interface Installation {
  id: number;
  account: { login?: string; slug?: string } | null;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // GET /authorize: redirect to GitHub's own consent screen
  if (url.pathname.endsWith("/authorize")) {
    const redirectOrigin = resolveRedirectOrigin(url);
    try {
      const { tenantId, userId } = await resolveTenantFromAuthorize(url);
      await enforceRouteRateLimit(tenantId, "github-oauth");

      const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
      authorizeUrl.searchParams.set("client_id", CLIENT_ID ?? "");
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI ?? "");
      authorizeUrl.searchParams.set("state", await createOAuthState(tenantId, userId, SOURCE, redirectOrigin));

      return Response.redirect(authorizeUrl.toString(), 302);
    } catch (err) {
      return authorizeErrorResponse(SOURCE, err, redirectOrigin);
    }
  }

  // GET /callback: exchange code for a (single-use) user token, look up
  // the installation(s) that user can see, persist the installation_id.
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
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
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
          error: `GitHub OAuth failed: ${tokenData.error ?? tokenData.error_description ?? "unknown error"}`,
          status: 400,
        }, redirectOrigin);
      }

      const installationsResp = await fetch("https://api.github.com/user/installations", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      const installationsData = await installationsResp.json();
      const installations = (installationsData.installations ?? []) as Installation[];

      if (!installationsResp.ok || installations.length === 0) {
        const installUrl = APP_SLUG ? `https://github.com/apps/${APP_SLUG}/installations/new` : null;
        return popupCallbackResponse(SOURCE, {
          success: false,
          error: installUrl
            ? `No GitHub App installation found for this account. Install it first at ${installUrl}, then reconnect.`
            : "No GitHub App installation found for this account. Install the app on your organization or repositories first, then reconnect.",
          status: 400,
        }, redirectOrigin);
      }

      // A user authorizing with access to more than one installation
      // (rare - usually only happens across multiple orgs) takes the
      // first, same defensive "more than one, pick one" precedent as
      // jira-oauth's accessible-resources handling. Supporting a real
      // picker across multiple installations is a real, deferred gap,
      // not something silently pretended not to exist.
      const installation = installations[0];
      const accountName = installation.account?.login ?? installation.account?.slug ?? String(installation.id);

      await ensureSourceConnectionDisplayNameColumn();
      await withTenant(tenantId, async (sql) => {
        await sql`
          insert into public.source_connections (
            tenant_id, source, external_workspace_id, display_name, oauth_token_ref,
            ingestion_mode, status, cursor_state, last_synced_at, connected_by
          ) values (
            ${tenantId}::uuid,
            'github',
            ${String(installation.id)},
            ${accountName},
            null,
            'polling',
            'active',
            ${sql.json({ installation_id: installation.id })},
            null,
            ${userId || null}::uuid
          )
          on conflict (tenant_id, source, external_workspace_id)
          do update set
            display_name = excluded.display_name,
            status = 'active',
            cursor_state = excluded.cursor_state,
            connected_by = excluded.connected_by
        `;
      });

      return popupCallbackResponse(SOURCE, { success: true }, redirectOrigin);
    } catch (error) {
      console.error("GitHub OAuth error:", error);
      return popupCallbackResponse(SOURCE, {
        success: false,
        error: "Internal Server Error",
        status: 500,
      }, redirectOrigin);
    }
  }

  return new Response("Not found", { status: 404 });
});
