// supabase/functions/purge-raw-events/index.ts
//
// Raw content retention was never actually enforced on the live path.
// raw_events.expires_at defaults to now() + 30 days (migration
// 003_public_design_schema.sql) and a real purge job exists
// (backend/.../jobs/cleanup/purge_raw.py, scheduled via APScheduler in
// backend/.../jobs/scheduler/base.py) - but that's the non-live Python
// backend this project migrated off of. Nothing on the live Supabase
// Edge Functions path ever deletes an expired row, so the 30-day retention
// promise in Settings > Privacy was aspirational copy, not enforced
// behavior. This is that job's live equivalent, meant to run daily via
// pg_cron (see supabase/migrations/20260808000000_purge_raw_events_cron.sql).
//
// Deployed with --no-verify-jwt: this only deletes rows already past their
// own expiry, which is supposed to happen regardless of who/what triggers
// it - there's no exploitable action here even if called by someone other
// than the cron job.

import { withAdmin } from "../_shared/db.ts";

Deno.serve(async (_req) => {
  try {
    const result = await withAdmin(async (sql) => {
      const deleted = await sql`
        DELETE FROM public.raw_events WHERE expires_at < now() RETURNING id, tenant_id, source
      `;
      return { deleted_count: deleted.length };
    });

    console.log(JSON.stringify({ event: "raw_events_purged", ...result }));
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("purge-raw-events failed:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
