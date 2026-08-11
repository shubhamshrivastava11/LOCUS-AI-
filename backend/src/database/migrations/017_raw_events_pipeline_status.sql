-- Track whether the AI pipeline actually finished for a raw_events row,
-- separately from whether the row exists at all.
--
-- Bug this fixes: modules.ingestion.dedup.ledger.is_duplicate() only checked
-- row existence. mark_seen() (store_raw_event) runs BEFORE the AI pipeline,
-- so if triage/extraction/persistence then throws (a transient Claude/Voyage
-- API error, a DB blip), the pgmq message is correctly left for retry, but
-- retrying it is a no-op forever after: is_duplicate() already sees the row
-- and skip-deletes the message without ever re-running the pipeline. The
-- content is never lost from raw_events, but a decision that should have
-- been created never is, permanently, with no error surfaced anywhere.
--
-- pipeline_status='done' is now set only once the pipeline reaches a real
-- terminal outcome (DISCARD, or a persisted decision) - not just once the
-- row is inserted. is_duplicate() checks this instead of bare existence, so
-- a row stuck at 'pending' after a crash is retried on the next pgmq
-- visibility-timeout cycle instead of being silently swallowed.

alter table public.raw_events
  add column if not exists pipeline_status text not null default 'pending'
    check (pipeline_status in ('pending', 'done'));

-- Existing rows predate this column and were, by definition, each already
-- run through the pipeline at least once (successfully or not - we can't
-- tell which from raw_events alone). Backfill to 'done' so this migration
-- doesn't itself trigger a mass reprocessing of the entire historical
-- table; the one-time repair for rows that are known-affected (checked
-- individually against decisions) is a separate, explicit script.
update public.raw_events set pipeline_status = 'done' where pipeline_status = 'pending';

create index if not exists idx_raw_events_pending
  on public.raw_events (tenant_id, source, source_id)
  where pipeline_status = 'pending';
