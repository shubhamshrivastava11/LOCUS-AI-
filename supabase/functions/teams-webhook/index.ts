// supabase/functions/teams-webhook/index.ts
//
// Receives Microsoft Graph change notifications for Teams channel messages.
//
// SECURITY, and why this is structurally safer than the bot version that
// preceded it:
//
// Notifications are requested WITHOUT resource data, so this endpoint never
// takes message content from the request body. A notification carries only
// a resource path; the content is then fetched from Graph using our own
// app-only token, and only for a Microsoft tenant that already has an
// active source_connections row. A forged POST therefore cannot inject a
// fabricated "decision" into anyone's memory - the worst it can do is ask
// us to re-fetch a message we were already entitled to read.
//
// clientState is still checked, as a per-connection shared secret, to stop
// unauthenticated traffic reaching Graph on our behalf at all.
//
// Deployed with --no-verify-jwt: Graph will not send a Supabase JWT.

import { withAdmin } from "../_shared/db.ts";
import { enqueueEvent } from "../_shared/queue.ts";
import {
  createChannelSubscription,
  fetchChannelName,
  fetchMessage,
  renewSubscription,
} from "../_shared/teamsGraph.ts";
import { htmlToPlainText } from "../_shared/htmlText.ts";

console.log("Microsoft Teams webhook (Graph subscriptions) started!");

const SELF = Deno.env.get("SUPABASE_URL") ?? "";
const NOTIFY_URL = `${SELF}/functions/v1/teams-webhook`;
const LIFECYCLE_URL = `${SELF}/functions/v1/teams-webhook?lifecycle=1`;

interface Notification {
  subscriptionId?: string;
  changeType?: string;
  tenantId?: string;
  clientState?: string;
  resource?: string;
  lifecycleEvent?: string;
  resourceData?: { id?: string };
}

interface ConnectionRow {
  id: string;
  tenant_id: string;
  external_workspace_id: string;
  cursor_state: { subscription_id?: string; client_state?: string } | null;
}

/**
 * Graph's resource path looks like:
 *   teams('<teamId>')/channels('<channelId>')/messages('<messageId>')
 * and occasionally has a /replies('<id>') tail for threaded replies.
 */
function parseResource(resource: string) {
  const ids = [...resource.matchAll(/\('([^']+)'\)/g)].map((m) => m[1]);
  return {
    teamId: ids[0] ?? "",
    channelId: ids[1] ?? "",
    messageId: ids[2] ?? "",
    replyId: ids[3] ?? "",
  };
}

async function connectionsFor(microsoftTenantId: string): Promise<ConnectionRow[]> {
  const rows = await withAdmin(async (sql) => {
    return await sql`
      select id, tenant_id, external_workspace_id, cursor_state
      from public.source_connections
      where source = 'teams'
        and external_workspace_id = ${microsoftTenantId}
        and status = 'active'
    `;
  });
  return rows as unknown as ConnectionRow[];
}

/**
 * Records a channel Locus has heard from, so Build Memory has something to
 * list. Graph has no "which channels may this app see" call - the app can
 * see all of them - so the registry is still built from observed traffic,
 * exactly as the bot version did.
 */
async function recordChannel(
  microsoftTenantId: string,
  channelId: string,
  name: string | null,
  team: string | null,
): Promise<void> {
  if (!channelId) return;
  try {
    await withAdmin(async (sql) => {
      await sql`
        update public.source_connections
        set cursor_state = coalesce(cursor_state, '{}'::jsonb) || jsonb_build_object(
          'channels',
          coalesce(cursor_state -> 'channels', '{}'::jsonb) || jsonb_build_object(
            ${channelId}::text, ${sql.json({ name, team })}::jsonb
          )
        )
        where source = 'teams'
          and external_workspace_id = ${microsoftTenantId}
          and status = 'active'
      `;
    });
  } catch (err) {
    console.error("Teams: channel registry update failed (non-fatal):", err);
  }
}

async function stampSynced(microsoftTenantId: string): Promise<void> {
  try {
    await withAdmin(async (sql) => {
      await sql`
        update public.source_connections
        set last_synced_at = ${new Date().toISOString()}
        where source = 'teams'
          and external_workspace_id = ${microsoftTenantId}
          and status = 'active'
      `;
    });
  } catch (err) {
    console.error("Teams: last_synced_at stamp failed (non-fatal):", err);
  }
}

/**
 * Lifecycle events tell us a subscription needs attention before it dies.
 * reauthorizationRequired is routine and just needs a renew;
 * subscriptionRemoved means Graph dropped it and we must build a new one.
 */
async function handleLifecycle(n: Notification): Promise<void> {
  const microsoftTenantId = n.tenantId ?? "";
  if (!microsoftTenantId) return;
  const connections = await connectionsFor(microsoftTenantId);
  if (connections.length === 0) return;

  for (const conn of connections) {
    const subId = conn.cursor_state?.subscription_id;
    const clientState = conn.cursor_state?.client_state ?? "";
    try {
      if (n.lifecycleEvent === "subscriptionRemoved" || !subId) {
        const sub = await createChannelSubscription(
          microsoftTenantId, NOTIFY_URL, LIFECYCLE_URL, clientState,
        );
        await withAdmin(async (sql) => {
          await sql`
            update public.source_connections
            set cursor_state = coalesce(cursor_state, '{}'::jsonb)
              || jsonb_build_object('subscription_id', ${sub.id}::text,
                                    'subscription_expires_at', ${sub.expirationDateTime}::text)
            where id = ${conn.id}::uuid
          `;
        });
        console.log(`Teams: resubscribed for tenant ${microsoftTenantId}`);
      } else {
        const sub = await renewSubscription(microsoftTenantId, subId);
        await withAdmin(async (sql) => {
          await sql`
            update public.source_connections
            set cursor_state = coalesce(cursor_state, '{}'::jsonb)
              || jsonb_build_object('subscription_expires_at', ${sub.expirationDateTime}::text)
            where id = ${conn.id}::uuid
          `;
        });
        console.log(`Teams: renewed on lifecycle event for tenant ${microsoftTenantId}`);
      }
    } catch (err) {
      console.error("Teams lifecycle handling failed:", err);
    }
  }
}

async function handleMessage(n: Notification): Promise<void> {
  const microsoftTenantId = n.tenantId ?? "";
  const resource = n.resource ?? "";
  if (!microsoftTenantId || !resource) return;

  const connections = await connectionsFor(microsoftTenantId);
  if (connections.length === 0) {
    // Subscribed but no Locus tenant claims this Microsoft tenant. Nothing
    // to attribute it to, and guessing would be a cross-tenant leak.
    return;
  }

  // Per-connection shared secret. Content safety does not depend on this
  // (see the header), but it keeps unauthenticated callers from making us
  // call Graph.
  const expected = connections[0].cursor_state?.client_state ?? "";
  if (expected && n.clientState !== expected) {
    console.error("Teams: clientState mismatch, ignoring notification");
    return;
  }

  const { teamId, channelId, messageId, replyId } = parseResource(resource);
  const message = await fetchMessage(microsoftTenantId, resource);
  if (!message) return;

  // Skip system messages (joins, renames) and anything the app itself said.
  if (message.messageType && message.messageType !== "message") return;
  const authorId = message.from?.user?.id;
  if (!authorId) return; // application-authored, not a person

  const text = htmlToPlainText(message.body?.content ?? "").trim();
  if (!text) return;

  const { team, channel } = await fetchChannelName(microsoftTenantId, teamId, channelId);
  await recordChannel(microsoftTenantId, channelId, channel, team);

  const permalink = message.webUrl ??
    (channelId && messageId
      ? `https://teams.microsoft.com/l/message/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}?tenantId=${encodeURIComponent(microsoftTenantId)}`
      : undefined);

  const receivedAt = new Date().toISOString();
  for (const conn of connections) {
    await enqueueEvent({
      tenant_id: conn.tenant_id,
      source: "teams",
      source_id: replyId || messageId || crypto.randomUUID(),
      actor: authorId,
      actor_display_name: message.from?.user?.displayName ?? undefined,
      // Replies group under the message they answer; a new post groups
      // under itself. Same rule the Slack connector had to be fixed to use.
      thread_ref: message.replyToId || messageId,
      permission_scope: channelId ? [channelId] : [],
      capture_item_id: channelId || undefined,
      raw_content: { text },
      source_permalink: permalink,
      received_at: receivedAt,
      connection_id: conn.id,
    });
  }
  await stampSynced(microsoftTenantId);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Graph's handshake, sent on both the notification and lifecycle URLs at
  // subscription creation. Must echo the token as plain text, promptly, or
  // creation fails for reasons unrelated to permissions.
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: { value?: Notification[] };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const isLifecycle = url.searchParams.get("lifecycle") === "1";
  for (const n of body.value ?? []) {
    try {
      if (isLifecycle || n.lifecycleEvent) {
        await handleLifecycle(n);
      } else {
        await handleMessage(n);
      }
    } catch (err) {
      // One bad notification must not fail the batch; Graph would retry
      // the whole thing and duplicate the rest.
      console.error("Teams notification handling failed:", err);
    }
  }

  // 202 tells Graph the batch was accepted.
  return new Response(null, { status: 202 });
});
