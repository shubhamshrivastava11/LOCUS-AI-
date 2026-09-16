-- Run the health checks every ten minutes.
--
-- Ten rather than one: the full battery takes around 45 seconds, most of it
-- the permission canary walking six accounts through the real access rule, and
-- a monitor that occupies the database more often than it needs to becomes a
-- cause of the incidents it exists to report. Ten minutes is well inside the
-- window that matters here - the 16 Sep outage ran for most of a day.
--
-- The internal key is read from Supabase Vault at call time, never written
-- into cron.job, whose command column is plainly readable to anyone who can
-- query the database. Same pattern as slack-membership-sync. The secret is
-- created once, out of band:
--
--   select vault.create_secret('<INTERNAL_FUNCTION_KEY>', 'admin_health_internal_key');
--
-- This migration only wires the lookup.
--
-- x-internal-key rather than Authorization, deliberately: requireInternalKey
-- checks that header first precisely so a caller can satisfy a gateway with
-- one credential and the endpoint with another without the two colliding.
--
-- WHAT THIS CANNOT DO, stated because it is the obvious hole. A monitor that
-- runs inside the system it watches cannot report that the system is down. If
-- the project is unreachable, pg_cron does not fire and no alert is sent, and
-- silence looks identical to health - which is the exact failure mode this
-- whole piece of work exists to remove. The endpoint answers 503 when any
-- check fails specifically so an EXTERNAL uptime pinger can be pointed at it
-- and need to know nothing about the response body. Until one is, this covers
-- "the system is running and answering wrongly", not "the system is gone".

select cron.unschedule('admin-health-every-10-min')
where exists (select 1 from cron.job where jobname = 'admin-health-every-10-min');

select cron.schedule(
  'admin-health-every-10-min',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://imazdfzxinltbgktrgmv.supabase.co/functions/v1/admin-health',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-key', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'admin_health_internal_key'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
