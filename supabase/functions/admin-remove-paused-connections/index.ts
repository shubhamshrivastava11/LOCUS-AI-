// supabase/functions/admin-remove-paused-connections/index.ts
//
// One-off cleanup: the duplicate-mailbox connections paused earlier this
// session (same real Gmail account connected under more than one tenant)
// are still sitting in source_connections with status='paused'. That's
// enough to stop them from draining tokens, but a paused row still holds
// the (tenant_id, source, external_workspace_id) unique slot - the mailbox
// owner can't freely reconnect fresh without it being in the way. This
// actually removes them: their own captured decisions/raw_events first
// (real duplicates of what the surviving active connection already has),
// then the connection row itself, so a future reconnect starts clean.
//
// ?mode=preview (default) - read-only, reports what WOULD be removed.
// ?mode=apply             - actually deletes.

import { withAdmin } from "../_shared/db.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const apply = url.searchParams.get("mode") === "apply";

  try {
    const result = await withAdmin(async (sql) => {
      const connRows = await sql`
        SELECT id, tenant_id, source, external_workspace_id, display_name, created_at
        FROM public.source_connections
        WHERE status = 'paused'
      `;
      type ConnRow = {
        id: string; tenant_id: string; source: string;
        external_workspace_id: string | null; display_name: string | null; created_at: string;
      };
      const typedConns = connRows as unknown as ConnRow[];

      const report: unknown[] = [];
      for (const conn of typedConns) {
        const rawEventRows = await sql`
          SELECT id FROM public.raw_events WHERE connection_id = ${conn.id} AND tenant_id = ${conn.tenant_id}
        `;
        const rawEventIds = (rawEventRows as unknown as { id: string }[]).map((r) => r.id);

        let decisionsDeleted = 0;
        let rawEventsDeleted = 0;

        if (apply) {
          if (rawEventIds.length > 0) {
            const deletedDecisions = await sql`
              DELETE FROM public.decisions
              WHERE tenant_id = ${conn.tenant_id} AND origin_raw_event_id = ANY(${rawEventIds})
              RETURNING id
            `;
            decisionsDeleted = deletedDecisions.length;

            const deletedRaw = await sql`
              DELETE FROM public.raw_events
              WHERE tenant_id = ${conn.tenant_id} AND id = ANY(${rawEventIds})
              RETURNING id
            `;
            rawEventsDeleted = deletedRaw.length;
          }
          await sql`DELETE FROM public.source_connections WHERE id = ${conn.id} AND tenant_id = ${conn.tenant_id}`;
        }

        report.push({
          connection_id: conn.id,
          tenant_id: conn.tenant_id,
          source: conn.source,
          account: conn.display_name ?? conn.external_workspace_id,
          connected_at: conn.created_at,
          raw_events_found: rawEventIds.length,
          decisions_deleted: decisionsDeleted,
          raw_events_deleted: rawEventsDeleted,
        });
      }

      return report;
    });

    return json({ mode: apply ? "apply" : "preview", connections_found: result.length, connections: result });
  } catch (err) {
    console.error("admin-remove-paused-connections failed:", err);
    return json({ error: String(err) }, 500);
  }
});
