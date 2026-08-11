// supabase/functions/admin-fix-notion-permalinks/index.ts
//
// One-off backfill: some Notion decisions never got a decision_sources row,
// so "View Original" renders disabled - nothing for it to link to. Notion's
// Search API result always carries page.url, so ai-worker's `if (permalink)`
// check before inserting decision_sources should mean this basically never
// happens on a live poll; these 91 rows are all clustered on a single day
// (2026-08-01), which points at a one-time backfill/seed import that never
// ran through the same real-poll path rather than an ongoing bug.
//
// Doesn't need to decrypt raw_content to recover the original page.url -
// Notion's page URLs are just https://www.notion.so/<page-id-no-dashes>,
// deterministic from the id alone, and raw_events.source_id is always that
// same page id (see notion-poller: source_id: page.id) regardless of
// whether the original page.url ever made it into the stored envelope.
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
        SELECT d.id AS decision_id, d.tenant_id, re.id AS raw_event_id, re.source_id,
               'https://www.notion.so/' || replace(re.source_id, '-', '') AS new_permalink
        FROM public.decisions d
        JOIN public.raw_events re ON re.id = d.origin_raw_event_id AND re.tenant_id = d.tenant_id
        LEFT JOIN public.decision_sources ds ON ds.decision_id = d.id AND ds.tenant_id = d.tenant_id
        WHERE re.source = 'notion' AND ds.decision_id IS NULL
      `;

      if (!apply) {
        return { mode: "preview", would_insert: affected.length, sample: affected.slice(0, 10) };
      }

      let inserted = 0;
      for (
        const row of affected as unknown as
          { decision_id: string; tenant_id: string; raw_event_id: string; new_permalink: string }[]
      ) {
        await sql`
          INSERT INTO public.decision_sources (tenant_id, decision_id, raw_event_id, permalink)
          VALUES (${row.tenant_id}, ${row.decision_id}, ${row.raw_event_id}, ${row.new_permalink})
          ON CONFLICT (decision_id, permalink) DO NOTHING
        `;
        inserted++;
      }
      return { mode: "apply", inserted };
    });

    return json(result);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
