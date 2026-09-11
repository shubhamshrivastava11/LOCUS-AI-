-- Temporal memory model (ClickUp #86bbpzbt3, "Build Temporal Memory Model").
--
-- Adds temporal validity to structured memories so current information is
-- distinguishable from historical information, and prior states are readable
-- rather than merely retained.
--
-- What already existed: decisions.superseded_by. Conflict detection in
-- ai-worker marks a duplicate/contradicted decision as superseded instead of
-- deleting or overwriting it, so prior states were already preserved. What
-- was missing is WHEN each state was true, which is what makes
-- point-in-time reconstruction possible.
--
-- Deliberately zero added AI cost: this is schema plus query semantics, no
-- model calls anywhere on the path. Reconstructing state at a past date is
-- a WHERE clause, not an inference.
--
--   valid_from   when this memory became true. The decision's own
--                created_at - the moment it entered the record.
--   valid_until  when it stopped being true: the created_at of whatever
--                superseded it. NULL means still current.
--
-- The invariant worth keeping in mind when reading queries elsewhere:
--   current            -> valid_until IS NULL   (equivalently superseded_by IS NULL)
--   true at time T     -> valid_from <= T AND (valid_until IS NULL OR valid_until > T)

alter table public.decisions
  add column if not exists valid_from timestamptz,
  add column if not exists valid_until timestamptz;

-- Backfill: a memory has been true since it was recorded.
update public.decisions
set valid_from = created_at
where valid_from is null;

-- Backfill: a superseded memory stopped being true when its replacement was
-- recorded. Joined through superseded_by so the two stay consistent - the
-- supersession graph is the source of truth, the timestamp is derived.
update public.decisions d
set valid_until = s.created_at
from public.decisions s
where d.superseded_by = s.id
  and d.tenant_id = s.tenant_id
  and d.valid_until is null;

alter table public.decisions
  alter column valid_from set default now();

-- Point-in-time reconstruction scans by tenant and time window, so index the
-- pair rather than either column alone.
create index if not exists idx_decisions_temporal
  on public.decisions (tenant_id, valid_from, valid_until);

comment on column public.decisions.valid_from is
  'When this memory became true (its created_at). Temporal memory model.';
comment on column public.decisions.valid_until is
  'When this memory stopped being true - the created_at of the decision that superseded it. NULL means currently true.';
