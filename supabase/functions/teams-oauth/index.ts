// supabase/functions/teams-oauth/index.ts
//
// Connecting Teams is an ADMIN CONSENT flow, not the usual OAuth code
// exchange every other connector here uses. That difference is forced:
// ChannelMessage.Read.All is an application permission, and application
// permissions have no user-consent path at all. Somebody with tenant admin
// rights has to approve it, once, for the whole organisation.
//
// What that means for the person clicking Connect: unlike Slack or Notion,
// this cannot be completed by an ordinary team member. If they are not an
// admin, Microsoft shows "Need admin approval" and offers to forward the
// request. That is Microsoft's flow, not something to work around.
//
// Sequence:
//   /authorize  -> Microsoft admin consent screen
//   /callback   -> Microsoft returns ?admin_consent=True&tenant=<tid>
//                  we then create the connection AND the Graph
//                  subscription, because consent alone delivers nothing.
//
// Deploy with --no-verify-jwt.

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
import { enforceRouteRateLimit } from "../_shared/routeRateLimit.ts";
import { createChannelSubscription, graphFetch } from "../_shared/teamsGraph.ts";

console.log("Microsoft Teams admin-consent handler started!");

const CLIENT_ID = Deno.env.get("TEAMS_CLIENT_ID") ?? "";
const REDIRECT_URI = Deno.env.get("TEAMS_REDIRECT_URI") ?? "";
const SELF = Deno.env.get("SUPABASE_URL") ?? "";
const NOTIFY_URL = `${SELF}/functions/v1/teams-webhook`;
const LIFECYCLE_URL = `${SELF}/functions/v1/teams-webhook?lifecycle=1`;

const SOURCE = "teams" as const;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/authorize")) {
    const redirectOrigin = resolveRedirectOrigin(url);
    try {
      const { tenantId, userId } = await resolveTenantFromAuthorize(url);
      await enforceRouteRateLimit(tenantId, "teams-oauth");

      // /organizations, not /common: personal Microsoft accounts have no
      // directory to consent on behalf of, and letting them reach the
      // screen only produces a confusing Microsoft-side error.
      const consent = new URL("https://login.microsoftonline.com/organizations/v2.0/adminconsent");
      consent.searchParams.set("client_id", CLIENT_ID);
      consent.searchParams.set("scope", "https://graph.microsoft.com/.default");
      consent.searchParams.set("redirect_uri", REDIRECT_URI);
      consent.searchParams.set("state", encodeState(tenantId, userId, redirectOrigin));

      return Response.redirect(consent.toString(), 302);
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

    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      const desc = url.searchParams.get("error_description") ?? oauthError;
      // The common case by far: the person who clicked Connect is not an
      // admin. Say so plainly rather than surfacing Microsoft's wording.
      const friendly = oauthError === "access_denied"
        ? "Connecting Teams needs a Microsoft 365 administrator to approve it for your organisation. Ask an admin to run this connection."
        : `Microsoft consent failed: ${desc}`;
      return popupCallbackResponse(SOURCE, { success: false, error: friendly, status: 400 }, redirectOrigin);
    }

    const microsoftTenantId = url.searchParams.get("tenant") ?? "";
    const granted = url.searchParams.get("admin_consent") === "True";
    if (!granted || !microsoftTenantId) {
      return popupCallbackResponse(SOURCE, {
        success: false,
        error: "Microsoft did not confirm admin consent for this organisation.",
        status: 400,
      }, redirectOrigin);
    }

    try {
      // Best effort friendly name for the Settings card.
      let displayName: string | null = null;
      try {
        const orgResp = await graphFetch(microsoftTenantId, "/organization");
        if (orgResp.ok) {
          displayName = (await orgResp.json())?.value?.[0]?.displayName ?? null;
        }
      } catch (err) {
        console.error("Teams: organization lookup failed (non-fatal):", err);
      }

      // Per-connection shared secret, echoed back by Graph on every
      // notification. Generated here so it never leaves our side.
      const clientState = crypto.randomUUID();

      // Consent on its own delivers nothing; the subscription is what makes
      // messages arrive. Created before the row is written so a failure
      // here does not leave a connection that looks healthy and is silent.
      const sub = await createChannelSubscription(
        microsoftTenantId, NOTIFY_URL, LIFECYCLE_URL, clientState,
      );

      await ensureSourceConnectionDisplayNameColumn();
      await withTenant(tenantId, async (sql) => {
        await sql`
          insert into public.source_connections (
            tenant_id, source, external_workspace_id, display_name, oauth_token_ref,
            ingestion_mode, status, cursor_state, last_synced_at, connected_by
          ) values (
            ${tenantId}::uuid, 'teams', ${microsoftTenantId}, ${displayName}, null,
            'realtime', 'active',
            ${sql.json({
              subscription_id: sub.id,
              subscription_expires_at: sub.expirationDateTime,
              client_state: clientState,
            })}::jsonb,
            null, ${userId || null}::uuid
          )
          on conflict (tenant_id, source, external_workspace_id)
          do update set
            display_name = excluded.display_name,
            status = 'active',
            cursor_state = coalesce(public.source_connections.cursor_state, '{}'::jsonb)
                           || excluded.cursor_state,
            connected_by = excluded.connected_by
        `;
      });

      return popupCallbackResponse(SOURCE, { success: true }, redirectOrigin);
    } catch (error) {
      console.error("Teams admin-consent error:", error);
      const message = error instanceof Error ? error.message : "Internal Server Error";
      // Surface the subscription failure rather than a generic 500: the
      // most likely cause is a tenant with no Teams provisioned, and that
      // is worth telling the person directly.
      const friendly = message.includes("hasn't been provisioned")
        ? "That Microsoft organisation does not have Microsoft Teams enabled."
        : "Could not start listening to Teams messages. Consent was granted, but the subscription failed.";
      return popupCallbackResponse(SOURCE, { success: false, error: friendly, status: 500 }, redirectOrigin);
    }
  }

  return new Response("Not found", { status: 404 });
});
