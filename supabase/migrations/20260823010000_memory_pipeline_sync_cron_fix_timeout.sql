-- RECOVERED FILE. The original was never committed; this content was read
-- back out of supabase_migrations.schema_migrations.statements on
-- 14 Sep 2026, which is where Supabase records the SQL it actually ran.
-- Byte-for-byte what was applied to production on 2026-08-23, so the repo and
-- the ledger now agree. Do not re-run it by hand; it is already applied.
--
-- Fixes a real bug found while manually verifying
-- 20260823000000_memory_pipeline_sync_cron.sql: pg_net's net.http_post
-- defaults timeout_milliseconds to 5000 (5s) when not passed explicitly.
-- This job's actual per-tenant work is Claude-call-bound and routinely
-- takes far longer than 5s - confirmed live, a manual test call got 10s
-- into processing the first tenant (3 memory_fixture_events rows written)
-- before the request was aborted mid-flight, producing zero completed
-- memories from that partial run. The 5s pg_net client timeout doesn't just
-- make net._http_response show a spurious failure while the function
-- quietly finishes in the background - the Edge Function invocation itself
-- gets cut off when the caller disconnects, so work in flight is actually
-- lost, not just under-reported.
--
-- cron.schedule() upserts by job name, so re-registering
-- 'memory-pipeline-sync-every-15min' here replaces the original job's
-- command with this corrected one rather than creating a duplicate.
--
-- timeout_milliseconds := 130000 sits above the Edge Function's own
-- internal SOFT_BUDGET_MS (110s, see memory-pipeline-sync/index.ts) with
-- margin for the in-flight tenant's call to finish after that budget trips,
-- while staying under Supabase's ~150s hard platform ceiling.

select cron.schedule(
  'memory-pipeline-sync-every-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://imazdfzxinltbgktrgmv.supabase.co/functions/v1/memory-pipeline-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'memory_pipeline_sync_service_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 130000
  );
  $$
);
