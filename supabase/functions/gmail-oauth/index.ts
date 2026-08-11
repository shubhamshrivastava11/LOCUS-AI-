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

console.log("Gmail OAuth handler started!");

const CLIENT_ID = Deno.env.get("GMAIL_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET");
const REDIRECT_URI = Deno.env.get("GMAIL_REDIRECT_URI");

const SOURCE = "gmail" as const;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // GET /authorize: redirect to Google's consent screen
  if (url.pathname.endsWith("/authorize")) {
    const redirectOrigin = resolveRedirectOrigin(url);
    const syncMode = url.searchParams.get("sync_mode") === "new" ? "new" : "full";
    try {
      const tenantId = await resolveTenantFromAuthorize(url);

      const scopes = [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/userinfo.email",
        "openid",
      ];
      const googleAuthUrl = new URL(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      googleAuthUrl.searchParams.set("client_id", CLIENT_ID ?? "");
      googleAuthUrl.searchParams.set("redirect_uri", REDIRECT_URI ?? "");
      googleAuthUrl.searchParams.set("response_type", "code");
      googleAuthUrl.searchParams.set("scope", scopes.join(" "));
      googleAuthUrl.searchParams.set("access_type", "offline");
      googleAuthUrl.searchParams.set("prompt", "consent");
      googleAuthUrl.searchParams.set("state", encodeState(tenantId, redirectOrigin, syncMode));

      return Response.redirect(googleAuthUrl.toString(), 302);
    } catch (err) {
      return authorizeErrorResponse(SOURCE, err, redirectOrigin);
    }
  }

  // GET /callback: handle Google's redirect back
  if (url.pathname.endsWith("/callback")) {
    let tenantId: string;
    let redirectOrigin: string;
    let syncMode: "full" | "new";
    try {
      ({ tenantId, redirectOrigin, syncMode } = parseTenantState(url.searchParams.get("state")));
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
      // 1. Exchange code for tokens
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLIENT_ID ?? "",
          client_secret: CLIENT_SECRET ?? "",
          code,
          redirect_uri: REDIRECT_URI ?? "",
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok) {
        return popupCallbackResponse(SOURCE, {
          success: false,
          error: `Gmail OAuth failed: ${tokenData.error ?? "unknown error"}`,
          status: 400,
        }, redirectOrigin);
      }

      // 2. Get the user's email address
      const userInfoResponse = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
      );
      const userInfo = await userInfoResponse.json();
      const email = userInfo.email;
      if (!email) {
        return popupCallbackResponse(SOURCE, {
          success: false,
          error: "Email address not returned by Google",
          status: 400,
        }, redirectOrigin);
      }

      // "new" means only pick up mail from this moment forward -
      // last_synced_at = now() gives gmail-manual-sync exactly that cursor,
      // matching notion-oauth's same choice. "full" (default, and every
      // first-time connect) must explicitly clear last_synced_at to null on
      // a RECONNECT too, not just leave it, so gmail-manual-sync's
      // first-sync backfill (see gmail-manual-sync/index.ts) actually
      // re-triggers instead of silently keeping the old cursor.
      const lastSyncedAt = syncMode === "new" ? new Date().toISOString() : null;

      // 3. Store the connection under tenant GUC (locus_app / APP_DATABASE_URL).
      const encryptedToken = await encryptToken(tokenData.access_token);
      try {
        await ensureSourceConnectionDisplayNameColumn();
        await withTenant(tenantId, async (sql) => {
          await sql`
            insert into public.source_connections (
              tenant_id, source, external_workspace_id, display_name, oauth_token_ref,
              ingestion_mode, status, cursor_state, last_synced_at
            ) values (
              ${tenantId}::uuid,
              'gmail',
              ${email},
              ${email},
              ${encryptedToken},
              'polling',
              'active',
              ${sql.json({
                history_id: null,
                refresh_token: tokenData.refresh_token ?? null,
              })}::jsonb,
              ${lastSyncedAt}
            )
            on conflict (tenant_id, source, external_workspace_id)
            do update set
              oauth_token_ref = excluded.oauth_token_ref,
              display_name = excluded.display_name,
              status = 'active',
              cursor_state = excluded.cursor_state,
              ingestion_mode = excluded.ingestion_mode,
              last_synced_at = excluded.last_synced_at
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
      console.error("OAuth error:", error);
      return popupCallbackResponse(SOURCE, {
        success: false,
        error: "Internal Server Error",
        status: 500,
      }, redirectOrigin);
    }
  }

  return new Response("Not found", { status: 404 });
});
