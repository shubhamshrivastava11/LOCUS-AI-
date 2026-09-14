-- RECOVERED FILE. The original was never committed; this content was read
-- back out of supabase_migrations.schema_migrations.statements on
-- 14 Sep 2026, which is where Supabase records the SQL it actually ran.
-- Byte-for-byte what was applied to production on 2026-08-23, so the repo and
-- the ledger now agree. Do not re-run it by hand; it is already applied.
--
-- Redesigns the memory-pipeline-sync cron dispatch after live verification
-- surfaced a real capacity problem: the previous shape (one net.http_post
-- per tick, the Edge Function looping over every active-connection tenant
-- sequentially inside a single invocation) produced long-running
-- invocations (60-130s of sequential Claude calls). This project's Nano
-- compute tier also runs ai-worker-every-minute continuously - confirmed
-- live via admin-pipeline-status that it was actively processing a burst of
-- decisions in the exact window these long single-tenant-loop invocations
-- were failing. Verified directly: even a single already-proven-reliable
-- call to memory-api's /fixtures/load (same underlying runFixtureLoad,
-- no code changes, known-good from many earlier manual runs this session)
-- started failing with WORKER_RESOURCE_LIMIT once it overlapped with that
-- contention - this is resource contention between two legitimate
-- concurrent workloads, not a bug in the new pipeline's own logic.
--
-- Fix: dispatch one net.http_post PER TENANT instead of one call that loops
-- internally. Each resulting Edge Function invocation now does the same
-- small amount of work a single manual /fixtures/load call already does
-- reliably (one tenant, per_source_limit=2), instead of chaining many
-- tenants' worth of sequential Claude calls into one long-lived invocation.
-- pg_net's net.http_post is fire-and-forget from the calling SQL's
-- perspective (queues the request, doesn't block the cron tick), so
-- fanning out to N tenants here doesn't make this migration's own
-- transaction any slower.
--
-- memory-pipeline-sync/index.ts's existing "sync every active tenant when
-- no tenant_id is given" loop is UNCHANGED and still there - it's just no
-- longer what the cron calls. It remains available for a manual one-off
-- "sync everyone right now" call, same as before.
--
-- cron.schedule() upserts by job name, so this replaces the previous
-- command under 'memory-pipeline-sync-every-15min' rather than creating a
-- duplicate job.

select cron.schedule(
  'memory-pipeline-sync-every-15min',
  '*/15 * * * *',
  $$
  do $do$
  declare
    active_tenant record;
  begin
    for active_tenant in
      select distinct tenant_id from public.source_connections where status = 'active'
    loop
      perform net.http_post(
        url := 'https://imazdfzxinltbgktrgmv.supabase.co/functions/v1/memory-pipeline-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'memory_pipeline_sync_service_key')
        ),
        body := jsonb_build_object('tenant_id', active_tenant.tenant_id),
        timeout_milliseconds := 130000
      );
    end loop;
  end;
  $do$;
  $$
);
