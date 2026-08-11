// supabase/functions/admin-backfill-slack-permalinks/index.ts
//
// One-off backfill: every decision_sources row captured via Slack before
// today used a slack:// deep link (opens the desktop app, not something a
// browser's "View Original" button can do anything useful with). ai-worker
// now resolves a real https:// permalink for new captures - this fixes the
// ones that already exist, using the same chat.getPermalink call, keyed off
// the channel/message ts already encoded in the stored slack:// URL.
//
// ?mode=preview (default) - read-only, reports what WOULD change.
// ?mode=apply             - actually updates the rows.
//
// Requires a valid Supabase key in the Authorization header (default JWT
// verification, not deployed with --no-verify-jwt) - admin maintenance tool.

import { withAdmin } from "../_shared/db.ts";
import { decryptToken } from "../_shared/tokenCrypto.ts";

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

// slack://channel?team=T...&id=C...&message=1699999999.123456
function parseSlackDeepLink(url: string): { channel: string; messageTs: string } | null {
  if (!url.startsWith("slack://")) return null;
  try {
    const parsed = new URL(url);
    const channel = parsed.searchParams.get("id");
    const messageTs = parsed.searchParams.get("message");
    if (!channel || !messageTs) return null;
    return { channel, messageTs };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const apply = url.searchParams.get("mode") === "apply";

  try {
    const result = await withAdmin(async (sql) => {
      const rows = await sql`
        SELECT ds.id, ds.tenant_id, ds.permalink
        FROM public.decision_sources ds
        WHERE ds.permalink LIKE 'slack://%'
      `;

      type Row = { id: string; tenant_id: string; permalink: string };
      const typedRows = rows as unknown as Row[];

      // One token lookup per tenant, not per row - most tenants have far
      // more decisions than Slack connections.
      const tokenByTenant = new Map<string, string | null>();
      async function getToken(tenantId: string): Promise<string | null> {
        if (tokenByTenant.has(tenantId)) return tokenByTenant.get(tenantId)!;
        const connRows = await sql`
          SELECT oauth_token_ref FROM public.source_connections
          WHERE tenant_id = ${tenantId} AND source = 'slack' AND status = 'active'
          ORDER BY created_at ASC LIMIT 1
        `;
        const token = await decryptToken(connRows[0]?.oauth_token_ref);
        tokenByTenant.set(tenantId, token);
        return token;
      }

      const resolved: { id: string; old: string; new: string }[] = [];
      const failed: { id: string; reason: string }[] = [];

      for (const row of typedRows) {
        const parsed = parseSlackDeepLink(row.permalink);
        if (!parsed) {
          failed.push({ id: row.id, reason: "could not parse slack:// link" });
          continue;
        }
        const token = await getToken(row.tenant_id);
        if (!token) {
          failed.push({ id: row.id, reason: "no active Slack connection/token for this tenant" });
          continue;
        }
        try {
          const resp = await fetch(
            `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(parsed.channel)}&message_ts=${encodeURIComponent(parsed.messageTs)}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          const data = await resp.json();
          if (data.ok && typeof data.permalink === "string") {
            resolved.push({ id: row.id, old: row.permalink, new: data.permalink });
          } else {
            failed.push({ id: row.id, reason: data.error ?? "chat.getPermalink returned not-ok" });
          }
        } catch (err) {
          failed.push({ id: row.id, reason: String(err) });
        }
      }

      if (apply) {
        for (const r of resolved) {
          await sql`UPDATE public.decision_sources SET permalink = ${r.new} WHERE id = ${r.id}`;
        }
      }

      return {
        mode: apply ? "apply" : "preview",
        slack_deep_links_found: typedRows.length,
        resolved_count: resolved.length,
        updated: apply ? resolved.length : 0,
        sample: resolved.slice(0, 20),
        failed_count: failed.length,
        failed_sample: failed.slice(0, 20),
      };
    });

    return json(result);
  } catch (err) {
    console.error("admin-backfill-slack-permalinks failed:", err);
    return json({ error: String(err) }, 500);
  }
});
