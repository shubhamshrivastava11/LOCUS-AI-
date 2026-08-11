// supabase/functions/slack-oauth/index.ts
//
// CORRECTED: was writing to a guessed "sources" table with wrong column
// names. Real table (from Lam's migrations, matching the DS lead's schema)
// is "source_connections" — see backend/src/database/migrations/003.
//
// oauth_token_ref now holds an AES-256-GCM-encrypted token (see
// _shared/tokenCrypto.ts), not the raw value - was plaintext, flagged with
// a TODO here as an interim state pending a real fix. AES-GCM here is that
// fix's interim step (Vault/KMS remains a real future upgrade, but doesn't
// block closing the plaintext-in-the-database gap now).

import { withTenant } from "../_shared/db.ts";
import { enqueueEvent } from "../_shared/queue.ts";
import { encryptToken } from "../_shared/tokenCrypto.ts";
import { ensureSourceConnectionDisplayNameColumn } from "../_shared/sourceConnectionSchema.ts";
import {
  authorizeErrorResponse,
  encodeState,
  parseTenantState,
  popupCallbackResponse,
  resolveRedirectOrigin,
  resolveTenantFromAuthorize,
} from "../_shared/oauth_tenant.ts";

const CLIENT_ID = Deno.env.get("SLACK_CLIENT_ID");
const CLIENT_SECRET = Deno.env.get("SLACK_CLIENT_SECRET");
const REDIRECT_URI = Deno.env.get("SLACK_REDIRECT_URI");

const SOURCE = "slack" as const;

// Slack has no polling cursor the way Gmail/Notion do - the webhook only
// ever sees messages that arrive AFTER it's connected, so "full history"
// has to be a one-time active pull at connect time instead of a cursor
// change. Bounded (channels x messages) to stay well inside the OAuth
// popup's realistic wait time - runs in the background via
// EdgeRuntime.waitUntil() so the popup still closes immediately either way.
const BACKFILL_MAX_CHANNELS = 15;
const BACKFILL_MESSAGES_PER_CHANNEL = 20;

async function backfillSlackHistory(tenantId: string, teamId: string, accessToken: string) {
  try {
    const channelsResp = await fetch(
      `https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=${BACKFILL_MAX_CHANNELS}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const channelsData = await channelsResp.json();
    if (!channelsData.ok) {
      console.error(`Slack backfill: conversations.list failed for team ${teamId}:`, channelsData.error);
      return;
    }

    const channels = (channelsData.channels ?? []).filter((c: { is_member?: boolean }) => c.is_member);

    for (const channel of channels) {
      try {
        const historyResp = await fetch(
          `https://slack.com/api/conversations.history?channel=${channel.id}&limit=${BACKFILL_MESSAGES_PER_CHANNEL}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        const historyData = await historyResp.json();
        if (!historyData.ok) {
          console.error(`Slack backfill: conversations.history failed for channel ${channel.id}:`, historyData.error);
          continue;
        }

        for (const message of historyData.messages ?? []) {
          // Same shape as slack-webhook's live envelope, including the
          // same DM-exclusion guarantee (public_channel/private_channel
          // only, im/mpim never requested above).
          if (message.type !== "message" || message.subtype) continue;
          const slackDeepLink = channel.id && message.ts
            ? `slack://channel?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(channel.id)}&message=${encodeURIComponent(message.ts)}`
            : undefined;
          await enqueueEvent({
            tenant_id: tenantId,
            source: "slack",
            source_id: String(message.ts),
            actor: String(message.user ?? "unknown"),
            // Same fix as slack-webhook: fall back to this message's own
            // ts, not the whole channel, so backfilled messages don't all
            // get treated as one giant unrelated "thread".
            thread_ref: String(message.thread_ts ?? message.ts),
            permission_scope: [String(channel.id)],
            raw_content: { text: String(message.text ?? "") },
            source_permalink: slackDeepLink,
            received_at: new Date(Number(message.ts) * 1000).toISOString(),
          });
        }
      } catch (err) {
        console.error(`Slack backfill: channel ${channel.id} failed:`, err);
      }
    }
  } catch (err) {
    console.error(`Slack backfill failed for team ${teamId}:`, err);
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/authorize")) {
    const redirectOrigin = resolveRedirectOrigin(url);
    const syncMode = url.searchParams.get("sync_mode") === "new" ? "new" : "full";
    try {
      const tenantId = await resolveTenantFromAuthorize(url);

      const slackAuthUrl = new URL("https://slack.com/oauth/v2/authorize");
      slackAuthUrl.searchParams.set("client_id", CLIENT_ID ?? "");
      slackAuthUrl.searchParams.set(
        "scope",
        // read scopes added so conversations.list works (Capture Controls'
        // real channel listing); users:read added so users.info can
        // resolve a real display name for someone who chatted without
        // ever being named in a decision (see resolveSlackNamesLive in
        // supabase/functions/api/index.ts) - existing connections need to
        // reconnect to pick up either of these, a token from before this
        // change won't have them.
        "channels:history,groups:history,im:history,mpim:history,chat:write,channels:read,groups:read,mpim:read,im:read,users:read",
      );
      slackAuthUrl.searchParams.set("redirect_uri", REDIRECT_URI ?? "");
      slackAuthUrl.searchParams.set("state", encodeState(tenantId, redirectOrigin, syncMode));

      return Response.redirect(slackAuthUrl.toString(), 302);
    } catch (err) {
      return authorizeErrorResponse(SOURCE, err, redirectOrigin);
    }
  }

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

    const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID ?? "",
        client_secret: CLIENT_SECRET ?? "",
        code,
        redirect_uri: REDIRECT_URI ?? "",
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.ok) {
      return popupCallbackResponse(SOURCE, {
        success: false,
        error: `Slack OAuth failed: ${tokenData.error ?? "unknown error"}`,
        status: 400,
      }, redirectOrigin);
    }

    try {
      const encryptedToken = await encryptToken(tokenData.access_token);
      // Slack's OAuth v2 token response includes team.name alongside
      // team.id - previously only the opaque id was kept, so two Slack
      // connections (or even one) had no human-readable way to tell which
      // real workspace was actually connected.
      await ensureSourceConnectionDisplayNameColumn();
      await withTenant(tenantId, async (sql) => {
        await sql`
          insert into public.source_connections (
            tenant_id, source, external_workspace_id, display_name, oauth_token_ref,
            ingestion_mode, status, cursor_state
          ) values (
            ${tenantId}::uuid,
            'slack',
            ${tokenData.team?.id ?? null},
            ${tokenData.team?.name ?? null},
            ${encryptedToken},
            'realtime',
            'active',
            ${sql.json({ bot_user_id: tokenData.bot_user_id ?? null })}::jsonb
          )
          on conflict (tenant_id, source, external_workspace_id)
          do update set
            oauth_token_ref = excluded.oauth_token_ref,
            display_name = excluded.display_name,
            status = 'active',
            cursor_state = excluded.cursor_state,
            ingestion_mode = excluded.ingestion_mode
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

    if (syncMode === "full") {
      const teamId = String(tokenData.team?.id ?? "");
      const backfillPromise = backfillSlackHistory(tenantId, teamId, tokenData.access_token);
      // deno-lint-ignore no-explicit-any
      const runtime = (globalThis as any).EdgeRuntime;
      if (runtime?.waitUntil) {
        runtime.waitUntil(backfillPromise);
      } else {
        void backfillPromise;
      }
    }

    return popupCallbackResponse(SOURCE, { success: true }, redirectOrigin);
  }

  return new Response("Not found", { status: 404 });
});
