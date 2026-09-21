-- Instrumentation for the Gmail prefilter, so we can measure what it drops
-- before deciding how to change it.
--
-- WHY THIS EXISTS. Gmail is 76% of everything ingested and produces 13% of
-- the records: 2,415 events, 41 decisions, a 1.7% yield against 49% for
-- Slack and 83% for Notion. The most likely cause is the bulk-mail
-- prefilter, which drops any email carrying a List-Unsubscribe header
-- before the extraction model sees it - and applicant tracking systems set
-- that header on genuine mail, which is how an early-access user ended up
-- with 50 emails ingested and an empty dashboard.
--
-- "Most likely" is the problem. The flag was passed on the queue and never
-- stored, so the drop was invisible: nothing recorded that an event had
-- been skipped, or why. The first attempt to diagnose this reached for
-- triage_result, which turns out to be 'pending' on every row of every
-- source including the ones with 83% yield - a dead column that proved
-- nothing while looking like evidence.
--
-- So: record the decision and the signals behind it, change no behaviour,
-- and come back with numbers.

-- Why the pipeline stopped for this event, when it stopped early. Null for
-- events that went through the model normally.
alter table public.raw_events
  add column if not exists skip_reason text;

alter table public.raw_events drop constraint if exists raw_events_skip_reason_known;
alter table public.raw_events add constraint raw_events_skip_reason_known
  check (skip_reason is null or skip_reason in (
    'bulk_mail',
    'trivial_ack',
    'learning_paused',
    'core_knowledge_only',
    'capture_excluded'
  ));

create index if not exists idx_raw_events_skip_reason
  on public.raw_events (tenant_id, source, skip_reason)
  where skip_reason is not null;

-- The individual signals, so a narrowed rule can be evaluated against real
-- mail without shipping it first. Stored per event rather than as one
-- boolean because the whole question is which COMBINATION should drop:
-- List-Unsubscribe alone is currently enough, and the hypothesis is that it
-- should require corroboration.
alter table public.raw_events
  add column if not exists filter_signals jsonb not null default '{}'::jsonb;

alter table public.raw_events drop constraint if exists raw_events_filter_signals_object;
alter table public.raw_events add constraint raw_events_filter_signals_object
  check (jsonb_typeof(filter_signals) = 'object');

comment on column public.raw_events.skip_reason is
  'Which prefilter ended this event early, or null if it reached the model.';
comment on column public.raw_events.filter_signals is
  'The signals the prefilter saw, so a proposed rule can be counterfactually '
  'evaluated against real traffic before being shipped.';
