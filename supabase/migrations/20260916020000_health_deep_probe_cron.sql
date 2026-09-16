-- The search probe, four times a day.
--
-- Separate from the ten-minute battery because it is the only check that costs
-- money: one embedding plus one synthesis call, measured at $0.00165 a run. Four
-- runs is under seven tenths of a cent a day against a $1 ceiling, and it books
-- that spend into pipeline_daily_usage like everything else rather than
-- spending invisibly.
--
-- Why it cannot just ride the ten-minute job: at 144 runs a day the same probe
-- would be roughly $0.24, a quarter of the daily ceiling spent watching rather
-- than working. Six-hourly is the right resolution for this failure anyway -
-- an expired Anthropic key or a provider outage is not a thing that resolves
-- itself in ten minutes, and the ten-minute checks already cover everything
-- that does.

select cron.unschedule('admin-health-deep-6h')
where exists (select 1 from cron.job where jobname = 'admin-health-deep-6h');

select cron.schedule(
  'admin-health-deep-6h',
  -- Offset from the hour so it never collides with the ten-minute job, which
  -- would have two runs contending for the same three-connection pool.
  '5 */6 * * *',
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
    body := '{"deep": true}'::jsonb,
    timeout_milliseconds := 140000
  );
  $$
);
