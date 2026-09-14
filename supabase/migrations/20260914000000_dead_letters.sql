-- Closes the "a dropped message leaves no trace" gap.
--
-- Both pipeline queues end their failure paths in pgmq.delete(), which was
-- believed to archive. It does not. pgmq.archive() moves a message to
-- pgmq.a_<queue>; pgmq.delete() destroys it. Checked on 14 Sep 2026:
-- pgmq.a_ingestion and pgmq.a_embedding_queue both hold zero rows despite
-- months of traffic, so every message either queue has ever given up on is
-- simply gone, along with the reason.
--
-- That is the same shape of failure that cost 62 Notion decisions their
-- embeddings: the system kept working, nothing errored anywhere a human
-- would look, and the loss was invisible until someone went looking for
-- data that should have been there.
--
-- One row per abandoned message, with the payload kept whole so a message
-- can be replayed rather than just counted. replayed_at is the flag for
-- that, deliberately nullable rather than a delete, so a replay that goes
-- wrong can still be traced back to what was replayed.
--
-- Not a pgmq queue. A queue would need reading to inspect, and the question
-- actually asked here is "what has been lost, and why", which is a scan.

create table public.dead_letters (
  id          uuid primary key default gen_random_uuid(),
  queue       text not null,
  msg_id      bigint not null,
  tenant_id   uuid references public.tenants(id) on delete cascade,
  -- Denormalised from the payload so the common triage question - which
  -- connector is failing - is answerable without digging through jsonb.
  source      text,
  source_id   text,
  payload     jsonb not null,
  error       text not null,
  attempts    integer not null default 1,
  failed_at   timestamptz not null default now(),
  replayed_at timestamptz
);

create index idx_dead_letters_failed on public.dead_letters (failed_at desc);
create index idx_dead_letters_queue on public.dead_letters (queue, failed_at desc);
-- Partial: "what is still outstanding" is the query that gets run, and it
-- stays cheap as replayed rows accumulate.
create index idx_dead_letters_outstanding on public.dead_letters (tenant_id, failed_at desc)
  where replayed_at is null;

alter table public.dead_letters enable row level security;
alter table public.dead_letters force row level security;

-- Same posture as request_traces: operational data written by the trusted
-- locus_app role and read by whoever is debugging. No authenticated-role
-- policy, because a payload here is raw source content that failed on its
-- way to redaction, and it should not be reachable from a browser at all.
drop policy if exists tenant_isolation_dead_letters on public.dead_letters;
create policy tenant_isolation_dead_letters on public.dead_letters
  using (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid);
