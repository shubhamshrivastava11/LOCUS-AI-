-- Membership data has to keep syncing, not run once. A stale cache would
-- recreate exactly the staleness problem this product exists to solve:
-- someone removed from a channel would keep access indefinitely, and
-- someone added would never get it. Hourly rather than every 5 minutes -
-- channel membership changes on the order of days, and each run costs a
-- conversations.members + users.info sweep against Slack's rate limits.
select cron.schedule(
  'slack-membership-sync-hourly',
  '7 * * * *',
  $$
  select net.http_post(
    url := 'https://imazdfzxinltbgktrgmv.supabase.co/functions/v1/slack-membership-sync',
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);

-- request_traces is one row per request and will grow without bound
-- otherwise. 30 days matches the retention already applied to raw_events -
-- long enough to investigate a regression, short enough that this stays a
-- cheap table on a Micro instance.
select cron.schedule(
  'purge-request-traces-daily',
  '30 2 * * *',
  $$ delete from public.request_traces where created_at < now() - interval '30 days'; $$
);
