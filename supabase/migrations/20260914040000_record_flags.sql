-- Gives the "Flag" button somewhere to put what it collects.
--
-- Finding 13 of the 14 Sep 2026 review, confirmed: FlagPanel is built
-- correctly and hands its caller (reason, note), and
-- MemoryRecordDetail.tsx:464 ignores both arguments:
--
--     onSubmit={() => {
--       setIsFlagging(false)
--       setFlagSubmitted(true)
--     }}
--
-- No request is made. The button turns to "Flagged", the reason and note are
-- dropped on the floor, and the state is gone on reload. Someone reporting a
-- wrong extraction is told it worked and nobody ever hears about it. A control
-- that lies about succeeding is worse than one that is missing.
--
-- Not folded into feedback_events: that table's signal column is CHECK
-- constrained to 'up'/'down' and its shape is (query, synthesized_answer) -
-- feedback about a generated ANSWER. This is feedback about a stored RECORD,
-- with a reason and a note. Two different things; conflating them would make
-- both awkward to query. feedback_events stays for answer rating, which has no
-- UI yet either.
--
-- Also the first real ground truth this system will have. Retrieval tuning -
-- RRF k=60, the 14-day recency half-life - has never been measured against
-- anything, because nothing recorded whether a result was any good. Flags are
-- a start: they mark records people actively dispute.

create table public.record_flags (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  decision_id uuid not null references public.decisions(id) on delete cascade,
  -- Nullable so a flag survives the account that raised it; the point is the
  -- record being wrong, not who said so.
  user_id     uuid,
  reason      text not null check (reason in ('Inaccurate', 'Outdated', 'Other')),
  note        text,
  created_at  timestamptz not null default now()
);

create index idx_record_flags_decision on public.record_flags (decision_id, created_at desc);
create index idx_record_flags_tenant on public.record_flags (tenant_id, created_at desc);

alter table public.record_flags enable row level security;
alter table public.record_flags force row level security;

-- locus_app lane, same shape as every other tenant-scoped table here.
drop policy if exists tenant_isolation_record_flags on public.record_flags;
create policy tenant_isolation_record_flags on public.record_flags
  using (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid);

-- The browser writes this one directly, deliberately: it is the user's own
-- feedback about their own tenant's record, and routing it through the API
-- would add a deploy surface for no authorization benefit.
--
-- INSERT only, and narrow. Unlike the source_connections policies dropped in
-- 20260914030000, this grants no ability to edit or delete anything - a flag
-- cannot be retracted by its author or anyone else through this path, so it
-- cannot be used to erase someone else's report. user_id is pinned to the
-- caller so a flag cannot be attributed to a colleague.
drop policy if exists record_flags_insert_authenticated on public.record_flags;
create policy record_flags_insert_authenticated on public.record_flags
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and tenant_id in (select m.tenant_id from public.memberships m where m.user_id = auth.uid())
  );

drop policy if exists record_flags_select_authenticated on public.record_flags;
create policy record_flags_select_authenticated on public.record_flags
  for select to authenticated
  using (tenant_id in (select m.tenant_id from public.memberships m where m.user_id = auth.uid()));
