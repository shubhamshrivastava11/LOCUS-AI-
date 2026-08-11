-- Registers the daily raw_events retention purge on pg_cron.
--
-- Settings > Privacy has always claimed raw content is deleted within 30
-- days (raw_events.expires_at defaults to now() + 30 days, migration
-- 003_public_design_schema.sql), but nothing on the live Edge Functions
-- path actually enforced it - the real purge job only ever existed in the
-- non-live Python backend this project migrated off of. This closes that
-- gap by invoking supabase/functions/purge-raw-events daily.

select cron.schedule(
  'purge-raw-events-daily',
  '0 2 * * *', -- 02:00 UTC daily
  $$
  select net.http_post(
    url := 'https://imazdfzxinltbgktrgmv.supabase.co/functions/v1/purge-raw-events',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
