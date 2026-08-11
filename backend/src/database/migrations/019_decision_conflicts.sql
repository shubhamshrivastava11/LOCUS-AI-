-- Automatic decision conflict detection: when a new decision is captured
-- and embedded, it's compared against its most similar existing decisions
-- (same mechanism /search already uses for retrieval) and Claude classifies
-- whether it genuinely contradicts or duplicates any of them. "Supersedes"
-- already has a home (decisions.superseded_by) - this table is only for the
-- two relationships that don't: two decisions that conflict but neither
-- explicitly replaces the other, and two that say the same thing twice.
--
-- decision_id is always the newer decision (the one just captured);
-- related_decision_id is the pre-existing one it was compared against.

create table if not exists public.decision_conflicts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  decision_id         uuid not null,
  related_decision_id uuid not null,
  relationship        text not null check (relationship in ('contradicts', 'duplicates')),
  reason              text not null,
  confidence          float not null default 0.0,
  created_at          timestamptz not null default now(),
  unique (decision_id, related_decision_id),
  constraint fk_decision_conflicts_decision
    foreign key (decision_id, tenant_id)
    references public.decisions(id, tenant_id) on delete cascade,
  constraint fk_decision_conflicts_related
    foreign key (related_decision_id, tenant_id)
    references public.decisions(id, tenant_id) on delete cascade
);

create index if not exists idx_decision_conflicts_decision
  on public.decision_conflicts (decision_id, tenant_id);
create index if not exists idx_decision_conflicts_related
  on public.decision_conflicts (related_decision_id, tenant_id);

alter table public.decision_conflicts enable row level security;

drop policy if exists tenant_isolation_decision_conflicts on public.decision_conflicts;
create policy tenant_isolation_decision_conflicts on public.decision_conflicts
  using (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid);
