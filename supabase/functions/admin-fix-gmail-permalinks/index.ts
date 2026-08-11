// supabase/functions/admin-fix-gmail-permalinks/index.ts
//
// One-off backfill: gmail-manual-sync's source_permalink was hardcoded to
// /mail/u/0/ (assumes Locus's connected Gmail is the browser's first-listed
// Google account) until this session's fix switched it to
// ?authuser=<email>#all/<id>. That fix only changes what NEW messages get
// baked into their queue payload at enqueue time - source_permalink is set
// once when gmail-manual-sync enqueues a message and just passed straight
// through by ai-worker into decision_sources.permalink, never recomputed.
// Every decision created from a message that was already sitting in the
// queue before the fix deployed (i.e. almost the entire backlog from the
// recent outage) still carries the old broken link. This rewrites those
// already-stored rows to the correct authuser-based link.
//
// ?apply=true actually updates; omitted (or anything else) previews only.

import { withAdmin } from "../_shared/db.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const apply = url.searchParams.get("apply") === "true";

  try {
    const result = await withAdmin(async (sql) => {
      const affected = await sql`
        SELECT ds.id AS decision_source_id, ds.decision_id, ds.permalink AS old_permalink,
               sc.external_workspace_id, re.source_id,
               'https://mail.google.com/mail/?authuser=' || sc.external_workspace_id || '#all/' || re.source_id AS new_permalink
        FROM public.decision_sources ds
        JOIN public.raw_events re ON re.id = ds.raw_event_id AND re.tenant_id = ds.tenant_id
        JOIN public.source_connections sc ON sc.id = re.connection_id AND sc.tenant_id = re.tenant_id
        WHERE re.source = 'gmail'
          AND ds.permalink LIKE '%/mail/u/0/%'
          AND sc.external_workspace_id IS NOT NULL
      `;

      if (!apply) {
        return { mode: "preview", would_update: affected.length, sample: affected.slice(0, 10) };
      }

      let updated = 0;
      for (const row of affected as unknown as { decision_source_id: string; new_permalink: string }[]) {
        await sql`
          UPDATE public.decision_sources SET permalink = ${row.new_permalink}
          WHERE id = ${row.decision_source_id}
        `;
        updated++;
      }
      return { mode: "apply", updated };
    });

    return json(result);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
