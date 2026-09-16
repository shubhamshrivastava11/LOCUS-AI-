-- Somewhere for the detector's findings to live.
--
-- Exploratory detection returned its candidates in the HTTP response and
-- nowhere else, which made a sweep only as durable as the client driving it.
-- The first real run proved the point: 435 pairs were examined across two
-- sessions and the second half was lost when the driving process was killed,
-- so 60 of 106 candidates exist only in a log file.
--
-- Deliberately NOT protected_facts. That table holds facts a human decided are
-- worth protecting, and on the test tenant it holds the planted ground truth
-- the detector is scored against. Writing model output into it would destroy
-- the distinction between what was planted and what was found, which is the
-- entire measurement.
--
-- Promotion from here to protected_facts is a human act, and that asymmetry is
-- the point: a detector proposes, a person decides what the company actually
-- considers sensitive.

create table if not exists public.candidate_channels (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  -- The record set that jointly implies the statement. Sorted before insert so
  -- the same pair found twice collides rather than duplicating.
  decision_ids uuid[] not null,
  statement    text not null,
  sensitivity  smallint check (sensitivity between 0 and 3),
  confidence   real not null default 0,
  similarity   real,
  -- Set when somebody promotes this into protected_facts, so a reviewed
  -- candidate is never re-reviewed and the promotion rate is measurable.
  promoted_to  uuid references public.protected_facts(id) on delete set null,
  reviewed_at  timestamptz,
  detected_at  timestamptz not null default now()
);

-- Idempotent sweeps. Re-running a range updates what it finds rather than
-- appending a second copy, so a resumed or overlapping sweep is safe.
create unique index if not exists idx_candidate_channels_set
  on public.candidate_channels (tenant_id, decision_ids);

create index if not exists idx_candidate_channels_review
  on public.candidate_channels (tenant_id, reviewed_at, confidence desc);

alter table public.candidate_channels enable row level security;
alter table public.candidate_channels force row level security;
drop policy if exists tenant_isolation_candidate_channels on public.candidate_channels;
create policy tenant_isolation_candidate_channels on public.candidate_channels
  for all using (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid);
revoke all on public.candidate_channels from anon, authenticated;
