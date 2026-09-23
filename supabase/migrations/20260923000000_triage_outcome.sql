-- Record what the model decided, and why.
--
-- triage_result has been written exactly once per row - as 'pending' at
-- insert - and never updated, on any source, since the column existed.
-- Every row of every connector reads 'pending', including the ones with an
-- 83% yield, so the column looked like evidence and carried none.
--
-- It cost real time. Diagnosing an empty Gmail dashboard, 'pending' on all
-- 2,415 rows read as "the model never saw these", which pointed at the
-- bulk-mail prefilter. Instrumenting that filter showed the opposite: 77%
-- of Gmail reaches the model and the model discards 98.8% of it. The filter
-- was never the main cause, and a day would have gone into narrowing it.
--
-- So: write the verdict down, and the reason with it. Without the reason
-- the next question - IS 98.8% correct for email, or is the prompt tuned
-- for team chat and wrong about inboxes - has no data behind it either.

alter table public.raw_events
  add column if not exists triage_reason text;

-- triage_result already carries a CHECK constraint from an earlier migration
-- allowing exactly pending/kept/uncertain/discarded. The first version of
-- this change wrote keep/discard/uncertain_held instead - near-miss synonyms
-- - and every write was rejected, dead-lettering 25 events. Latent all day
-- behind the spend cap, then immediate once the cap was raised. So: use the
-- vocabulary the schema already has rather than inventing a second spelling
-- of it, and read the constraint before writing the column. That is now
-- twice on this pipeline that a CHECK has stalled ingestion.
--
-- triage_reason takes no constraint, deliberately: reason codes are the
-- model's contract rather than the schema's, and a new one appearing should
-- show up in a query, not stall the queue.
comment on column public.raw_events.triage_result is
  'The model verdict: pending, kept, uncertain, or discarded. Written by '
  'ai-worker after the triage call, not at insert.';
comment on column public.raw_events.triage_reason is
  'The model reason_code behind that verdict, so low-yield sources can be '
  'told apart from low-signal ones.';

create index if not exists idx_raw_events_triage
  on public.raw_events (source, triage_result, triage_reason);
