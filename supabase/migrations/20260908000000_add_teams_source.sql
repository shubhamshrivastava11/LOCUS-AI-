-- Adds 'teams' (Microsoft Teams) to every source CHECK constraint at once,
-- same lesson from every connector before it: sweep all three tables
-- together. A source added to source_connections but not raw_events fails
-- only later, at the first ingested message, which is the worst place to
-- find out.
--
-- Note this is the second attempt at a Microsoft connector. The first
-- (outlook_calendar, added 20260831 and removed 20260901) went down the
-- tenant-wide ChannelMessage.Read.All route, which needs an IT admin and a
-- per-tenant Microsoft approval form for every customer. This one uses
-- resource-specific consent instead, granted by a team owner at app
-- install, so nothing here should need to be walked back the same way.

alter table public.source_connections drop constraint if exists source_connections_source_check;
alter table public.source_connections add constraint source_connections_source_check
  check (source = any (array['slack'::text, 'gmail'::text, 'notion'::text, 'jira'::text, 'confluence'::text, 'discord'::text, 'github'::text, 'monday'::text, 'clickup'::text, 'teams'::text]));

alter table public.raw_events drop constraint if exists raw_events_source_check;
alter table public.raw_events add constraint raw_events_source_check
  check (source = any (array['slack'::text, 'gmail'::text, 'notion'::text, 'jira'::text, 'confluence'::text, 'discord'::text, 'github'::text, 'monday'::text, 'clickup'::text, 'teams'::text]));

alter table public.capture_source_rules drop constraint if exists capture_source_rules_source_check;
alter table public.capture_source_rules add constraint capture_source_rules_source_check
  check (source = any (array['slack'::text, 'gmail'::text, 'notion'::text, 'jira'::text, 'confluence'::text, 'discord'::text, 'github'::text, 'monday'::text, 'clickup'::text, 'teams'::text]));

-- Actor identity for resolveActorId: a Microsoft account's UPN is an email
-- address, the same identifier space actors.email already indexes for
-- Gmail. No new column needed, same reasoning the earlier Microsoft
-- attempt reached.
