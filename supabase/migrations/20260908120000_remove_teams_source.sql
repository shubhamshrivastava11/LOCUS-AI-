-- Removes 'teams' again, the mirror of 20260908000000_add_teams_source.sql.
--
-- The connector itself was complete and deployed: OAuth tenant linking, a
-- Bot Framework webhook with real JWT signature verification, the RSC app
-- manifest, and Build Memory listing. It is being removed because of
-- Microsoft's tenancy rules rather than anything about the code:
--
--   1. Multi-tenant bot creation was retired after 31 July 2025, so a new
--      bot must be single-tenant and can only serve its own Entra tenant.
--   2. Reaching customers therefore requires an AppSource listing, which
--      needs Teams Store validation plus publisher verification.
--   3. Even testing it needs a tenant that HAS Teams and where we are
--      admin - the free M365 developer sandbox is now gated behind a
--      Visual Studio subscription or partner membership, leaving a paid
--      M365 trial as the only route.
--
-- Second Microsoft attempt to be reverted (after outlook_calendar on
-- 31 Aug / 1 Sep). Deleting the connection rows first, because the CHECK
-- constraints below would reject a surviving 'teams' row.

delete from public.capture_source_rules where source = 'teams';
delete from public.raw_events where source = 'teams';
delete from public.source_connections where source = 'teams';

alter table public.source_connections drop constraint if exists source_connections_source_check;
alter table public.source_connections add constraint source_connections_source_check
  check (source = any (array['slack'::text, 'gmail'::text, 'notion'::text, 'jira'::text, 'confluence'::text, 'discord'::text, 'github'::text, 'monday'::text, 'clickup'::text]));

alter table public.raw_events drop constraint if exists raw_events_source_check;
alter table public.raw_events add constraint raw_events_source_check
  check (source = any (array['slack'::text, 'gmail'::text, 'notion'::text, 'jira'::text, 'confluence'::text, 'discord'::text, 'github'::text, 'monday'::text, 'clickup'::text]));

alter table public.capture_source_rules drop constraint if exists capture_source_rules_source_check;
alter table public.capture_source_rules add constraint capture_source_rules_source_check
  check (source = any (array['slack'::text, 'gmail'::text, 'notion'::text, 'jira'::text, 'confluence'::text, 'discord'::text, 'github'::text, 'monday'::text, 'clickup'::text]));
