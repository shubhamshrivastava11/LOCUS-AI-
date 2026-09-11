-- Keeps valid_until in lockstep with superseded_by.
--
-- Found immediately after shipping 20260909100000: that migration backfilled
-- history correctly, but nothing maintained it going forward. Both places
-- that supersede a decision - ai-worker's detectConflicts and
-- admin-dedupe-decisions - set superseded_by and nothing else, so the next
-- real supersession would have produced a row that was superseded and yet
-- still answered "currently true" to every temporal query. Silent, and it
-- would have looked like the feature worked until someone asked a
-- point-in-time question months later.
--
-- A trigger rather than two edits, deliberately: the invariant then holds no
-- matter who writes, including a third call site nobody has written yet. The
-- supersession graph stays the source of truth and the timestamp stays
-- derived from it, which is the same relationship the backfill established.

create or replace function public.sync_decision_valid_until()
returns trigger
language plpgsql
as $$
begin
  -- Became superseded: it stopped being true when its replacement was recorded.
  if new.superseded_by is not null
     and (old.superseded_by is null or old.superseded_by <> new.superseded_by) then
    select d.created_at into new.valid_until
    from public.decisions d
    where d.id = new.superseded_by and d.tenant_id = new.tenant_id;

    -- Replacement missing or cross-tenant: fall back to now() rather than
    -- leaving valid_until null, which would misreport the row as current.
    if new.valid_until is null then
      new.valid_until := now();
    end if;
  end if;

  -- Un-superseded (a dedupe reversed): it is current again.
  if new.superseded_by is null and old.superseded_by is not null then
    new.valid_until := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_decisions_sync_valid_until on public.decisions;
create trigger trg_decisions_sync_valid_until
  before update on public.decisions
  for each row
  execute function public.sync_decision_valid_until();
