-- RECOVERED FILE. The original was never committed; this content was read
-- back out of supabase_migrations.schema_migrations.statements on
-- 14 Sep 2026, which is where Supabase records the SQL it actually ran.
-- Byte-for-byte what was applied to production on 2026-08-23, so the repo and
-- the ledger now agree. Do not re-run it by hand; it is already applied.
--
-- Registers the recurring memory-pipeline sync on pg_cron - the mechanism
-- behind "also allow it to future users": every tenant with an active
-- connector gets its new content run through extraction/entity-resolution
-- automatically going forward, not just the one-time manual replay calls
-- done by hand for the initial rollout. Deliberately NOT a one-time job -
-- a signup that happens after this migration runs still needs their content
-- picked up on some later tick, same reasoning as the Slack membership sync
-- job right above it in the schedule.
--
-- Every 15 minutes: frequent enough that a new signup's first connected
-- content shows up same-session, while staying well clear of the paired
-- Edge Function's per-tenant Claude-call cost - see
-- memory-pipeline-sync/index.ts's own header for why the function bounds
-- its own per-tenant and per-invocation work instead of relying on the cron
-- interval alone to keep this cheap.
--
-- memory-pipeline-sync requires the service_role key (requireServiceRole)
-- because it writes real memories into real tenants' data - net.http_post
-- needs that key in its Authorization header. It is NOT inlined here as
-- plaintext; it's read from Supabase Vault at call time via
-- vault.decrypted_secrets, same pattern as slack-membership-sync's own cron
-- job. Kept as its own separate secret (not reused from the Slack job) so
-- rotating or revoking one job's access is never coupled to the other's.
-- The secret itself ('memory_pipeline_sync_service_key') must be created
-- once, out of band, e.g.:
--   select vault.create_secret('<service-role-key>', 'memory_pipeline_sync_service_key');
-- This migration only wires the cron job to look it up - it never contains
-- the key value itself.

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
    body := '{}'::jsonb
  );
  $$
);
