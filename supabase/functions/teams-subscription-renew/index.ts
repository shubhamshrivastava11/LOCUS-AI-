// supabase/functions/teams-subscription-renew/index.ts
//
// Keeps Teams subscriptions alive.
//
// Graph caps a /teams/getAllMessages subscription at one hour. When it
// lapses, Graph simply stops delivering: no error, no callback, no signal
// anywhere in our system. The connection would still read "active" in
// Settings while silently ingesting nothing, which is the same class of
// invisible failure that cost 62 decisions their embeddings earlier.
//
// teams-webhook already renews on Graph's own lifecycle notifications.
// This cron exists because that path depends on Graph reaching us; if a
// deploy, an outage or a bad response causes one to be missed, nothing
// else would ever notice. Renewing on a schedule as well means a single
// missed notification costs minutes, not the connection.
//
// Runs every 15 minutes; renews anything expiring within 25.

import { withAdmin } from "../_shared/db.ts";
import { createChannelSubscription, renewSubscription } from "../_shared/teamsGraph.ts";

const SELF = Deno.env.get("SUPABASE_URL") ?? "";
const NOTIFY_URL = `${SELF}/functions/v1/teams-webhook`;
const LIFECYCLE_URL = `${SELF}/functions/v1/teams-webhook?lifecycle=1`;

const RENEW_WITHIN_MS = 25 * 60_000;

interface Row {
  id: string;
  external_workspace_id: string;
  cursor_state: {
    subscription_id?: string;
    subscription_expires_at?: string;
    client_state?: string;
  } | null;
}

Deno.serve(async (_req) => {
  const rows = await withAdmin(async (sql) => {
    return await sql`
      select id, external_workspace_id, cursor_state
      from public.source_connections
      where source = 'teams' and status = 'active'
    `;
  }) as unknown as Row[];

  let renewed = 0, recreated = 0, failed = 0, skipped = 0;
  // Graph's own error text, surfaced rather than swallowed. Without it a
  // failure count says something broke and nothing about what, which is
  // the situation the tracing work earlier in this project existed to end.
  // These are Microsoft error strings, never credentials.
  const errors: string[] = [];

  for (const row of rows) {
    const msTenant = row.external_workspace_id;
    const subId = row.cursor_state?.subscription_id;
    const expiresAt = row.cursor_state?.subscription_expires_at;
    const clientState = row.cursor_state?.client_state ?? "";

    const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
    const dueSoon = Number.isNaN(expiresMs) || expiresMs - Date.now() < RENEW_WITHIN_MS;
    if (subId && !dueSoon) {
      skipped++;
      continue;
    }

    try {
      let sub;
      if (subId) {
        try {
          sub = await renewSubscription(msTenant, subId);
          renewed++;
        } catch (err) {
          // A subscription Graph has already dropped cannot be renewed,
          // only replaced. Falling through to create is the difference
          // between a connection that recovers itself and one that needs
          // a human to notice it died.
          console.error(`Teams renew failed for ${msTenant}, recreating:`, err);
          sub = await createChannelSubscription(msTenant, NOTIFY_URL, LIFECYCLE_URL, clientState);
          recreated++;
        }
      } else {
        sub = await createChannelSubscription(msTenant, NOTIFY_URL, LIFECYCLE_URL, clientState);
        recreated++;
      }

      await withAdmin(async (sql) => {
        await sql`
          update public.source_connections
          set cursor_state = coalesce(cursor_state, '{}'::jsonb)
            || jsonb_build_object('subscription_id', ${sub.id}::text,
                                  'subscription_expires_at', ${sub.expirationDateTime}::text)
          where id = ${row.id}::uuid
        `;
      });
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message.slice(0, 300));
      console.error(`Teams subscription upkeep failed for tenant ${msTenant}:`, err);
    }
  }

  const summary = { connections: rows.length, renewed, recreated, failed, skipped, errors };
  console.log("Teams subscription upkeep:", JSON.stringify(summary));
  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
