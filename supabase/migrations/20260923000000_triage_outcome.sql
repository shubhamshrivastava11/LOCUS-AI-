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

-- 'pending' until the worker reports back, then the model's own verdict.
-- Deliberately not a CHECK constraint: the set of verdicts is the model's
-- contract rather than the schema's, and a new one appearing should show up
-- in a query, not stall the pipeline the way the classified_by constraint
-- nearly did.
comment on column public.raw_events.triage_result is
  'The model verdict: pending, keep, discard, or uncertain_held. Written by '
  'ai-worker after the triage call, not at insert.';
comment on column public.raw_events.triage_reason is
  'The model reason_code behind that verdict, so low-yield sources can be '
  'told apart from low-signal ones.';

create index if not exists idx_raw_events_triage
  on public.raw_events (source, triage_result, triage_reason);
