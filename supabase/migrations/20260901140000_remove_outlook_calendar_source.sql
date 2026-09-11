-- Removes the outlook_calendar source entirely: the connector, poller,
-- and app registration are being pulled for now (real Azure/Entra tenant
-- friction on the account trying to stand this up, not a code issue).
-- Reversing the two migrations that added it
-- (20260831070000_add_outlook_calendar_source.sql,
-- 20260831080000_outlook_calendar_poller_cron.sql) rather than editing
-- them in place, same convention as every other migration here.

select cron.unschedule('outlook-calendar-poller-every-5-min');

alter table public.source_connections drop constraint if exists source_connections_source_check;
alter table public.source_connections add constraint source_connections_source_check
  check (source = any (array['slack'::text, 'gmail'::text, 'notion'::text, 'jira'::text, 'confluence'::text, 'discord'::text, 'github'::text, 'monday'::text, 'clickup'::text]));

alter table public.raw_events drop constraint if exists raw_events_source_check;
alter table public.raw_events add constraint raw_events_source_check
  check (source = any (array['slack'::text, 'gmail'::text, 'notion'::text, 'jira'::text, 'confluence'::text, 'discord'::text, 'github'::text, 'monday'::text, 'clickup'::text]));

alter table public.capture_source_rules drop constraint if exists capture_source_rules_source_check;
alter table public.capture_source_rules add constraint capture_source_rules_source_check
  check (source = any (array['slack'::text, 'gmail'::text, 'notion'::text, 'jira'::text, 'confluence'::text, 'discord'::text, 'github'::text, 'monday'::text, 'clickup'::text]));

-- Deliberately NOT deleting any existing outlook_calendar rows in
-- source_connections/raw_events/decisions - nobody ever completed a real
-- connection (the OAuth flow never got past Azure app-registration setup),
-- so there's nothing real to clean up, and this stays non-destructive if
-- that assumption is ever wrong.
