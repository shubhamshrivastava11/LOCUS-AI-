-- Backfill: correct raw_events.thread_ref for Slack messages that were
-- captured before the channel-id fallback was fixed (supabase/functions/
-- slack-webhook and slack-oauth's backfillSlackHistory both used to set
-- thread_ref = channel id for any message with no real reply-thread, so
-- every message ever posted in that channel was treated as "the same
-- thread" as every other - a decision's reconstructed conversation ended
-- up including completely unrelated channel chatter).
--
-- A real Slack thread_ts is always "<digits>.<digits>" (a Unix timestamp);
-- a Slack channel id always starts with C/D/G followed by alphanumerics
-- and never matches that shape - so any slack row whose thread_ref looks
-- like a channel id is unambiguously a row hit by the old bug, never a
-- false positive against a genuine thread_ts.
--
-- source_id already holds the message's own ts for every Slack row (set
-- by both the webhook and the backfill path), which is exactly the value
-- the fixed code now uses as thread_ref for an unthreaded message - so
-- this reuses that column rather than inventing a new value.

update public.raw_events
set thread_ref = source_id
where source = 'slack'
  and thread_ref ~ '^[CDG][A-Z0-9]{6,}$';
