-- Re-adds 'teams' after the bot-based attempt was reverted on 8 Sep.
--
-- Third Microsoft attempt, and the first with the policy questions
-- actually tested rather than read off documentation. Verified live
-- against Graph before rebuilding:
--
--   * a token carrying roles: ['ChannelMessage.Read.All'] reaches the
--     resource check with no protected-API gate and no approval form;
--   * no 402, consistent with Teams APIs ceasing to be metered on
--     25 Aug 2025;
--   * no bot, so the multi-tenant bot retirement and the AppSource
--     listing that sank attempt 2 are both irrelevant.
--
-- What remains, and cannot be engineered away: tenant admin consent,
-- because application permissions have no user-consent path.

alter table public.source_connections drop constraint if exists source_connections_source_check;
alter table public.source_connections add constraint source_connections_source_check
  check (source = any (array['slack'::text, 'gmail'::text, 'notion'::text, 'jira'::text, 'confluence'::text, 'discord'::text, 'github'::text, 'monday'::text, 'clickup'::text, 'teams'::text]));

alter table public.raw_events drop constraint if exists raw_events_source_check;
alter table public.raw_events add constraint raw_events_source_check
  check (source = any (array['slack'::text, 'gmail'::text, 'notion'::text, 'jira'::text, 'confluence'::text, 'discord'::text, 'github'::text, 'monday'::text, 'clickup'::text, 'teams'::text]));

alter table public.capture_source_rules drop constraint if exists capture_source_rules_source_check;
alter table public.capture_source_rules add constraint capture_source_rules_source_check
  check (source = any (array['slack'::text, 'gmail'::text, 'notion'::text, 'jira'::text, 'confluence'::text, 'discord'::text, 'github'::text, 'monday'::text, 'clickup'::text, 'teams'::text]));
