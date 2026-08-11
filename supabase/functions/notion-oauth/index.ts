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

console.log("Notion OAuth handler started!");

const CLIENT_ID = Deno.env.get("NOTION_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("NOTION_CLIENT_SECRET");
const REDIRECT_URI = Deno.env.get("NOTION_REDIRECT_URI");

const SOURCE = "notion" as const;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // GET /authorize: Redirect to Notion consent screen
  if (url.pathname.endsWith("/authorize")) {
    const redirectOrigin = resolveRedirectOrigin(url);
    const syncMode = url.searchParams.get("sync_mode") === "new" ? "new" : "full";
    try {
      const tenantId = await resolveTenantFromAuthorize(url);

      const notionAuthUrl = new URL("https://api.notion.com/v1/oauth/authorize");
      notionAuthUrl.searchParams.set("client_id", CLIENT_ID ?? "");
      notionAuthUrl.searchParams.set("response_type", "code");
      notionAuthUrl.searchParams.set("owner", "user");
      notionAuthUrl.searchParams.set("redirect_uri", REDIRECT_URI ?? "");
      notionAuthUrl.searchParams.set("state", encodeState(tenantId, redirectOrigin, syncMode));

      return Response.redirect(notionAuthUrl.toString(), 302);
    } catch (err) {
      return authorizeErrorResponse(SOURCE, err, redirectOrigin);
    }
  }

  // GET /callback: Handle OAuth callback
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
      const tokenResponse = await fetch("https://api.notion.com/v1/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI ?? "",
        }),
      });

      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || tokenData.error) {
        return popupCallbackResponse(SOURCE, {
          success: false,
          error: `Notion OAuth failed: ${tokenData.error ?? "unknown error"}`,
          status: 400,
        }, redirectOrigin);
      }

      // "new" means only pick up content from this moment forward -
      // last_synced_at = now() gives notion-poller exactly that cursor.
      // "full" (default, and every first-time connect) must explicitly
      // clear last_synced_at back to null on a RECONNECT, not just leave
      // it - the upsert previously never touched this column at all, so
      // reconnecting after a disconnect kept whatever cursor was already
      // there instead of actually backfilling everything again.
      const lastSyncedAt = syncMode === "new" ? new Date().toISOString() : null;

      try {
        const encryptedToken = await encryptToken(tokenData.access_token);
        // Notion's token response includes workspace_name alongside the
        // opaque workspace_id - previously discarded, so a connected
        // workspace had no human-readable identity anywhere in the product.
        await ensureSourceConnectionDisplayNameColumn();
        await withTenant(tenantId, async (sql) => {
          await sql`
            insert into public.source_connections (
              tenant_id, source, external_workspace_id, display_name, oauth_token_ref,
              ingestion_mode, status, cursor_state, last_synced_at
            ) values (
              ${tenantId}::uuid,
              'notion',
              ${tokenData.workspace_id},
              ${tokenData.workspace_name ?? null},
              ${encryptedToken},
              'polling',
              'active',
              '{}'::jsonb,
              ${lastSyncedAt}
            )
            on conflict (tenant_id, source, external_workspace_id)
            do update set
              oauth_token_ref = excluded.oauth_token_ref,
              display_name = excluded.display_name,
              status = 'active',
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
