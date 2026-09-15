-- The set-level gate: tables only, no behaviour.
--
-- Conditions (1) to (4) of the access rule - tenancy, scope, clearance,
-- personal source - are all per-record. They cannot detect a fact derived from
-- two records that each pass individually. A Member may legitimately see "the
-- Helsinki office lease was not renewed" and "the entire platform team was
-- moved to the Berlin cost centre" and, holding both, know a thing neither
-- record states and that they have no clearance for.
--
-- Closing that needs a gate that reasons over the surviving SET rather than
-- over each record, and it sits in exactly one place: after
-- filterAccessibleDecisions and before synthesis in api /search.
--
-- This migration creates the storage and stops. The gate itself is behind
-- SET_LEVEL_GATE_ENABLED, default off, and detection has not run, so these
-- tables are empty and every query behaves exactly as it does today. That is
-- deliberate sequencing: the role hierarchy and classification are a better
-- permission model for a team product and ship on their own schedule; the gate
-- is a research contribution and belongs behind a flag until it is measured.
--
-- Cost note, because this is the part with a real budget risk. Detection is
-- offline and reuses the conflict detector's shape: narrow with
-- decision_embeddings first, then ask Haiku only about what survives.
-- Measured on production, 15 Sep 2026: 256 decisions give 14,739 pairs, of
-- which 298 clear the conflict detector's 0.72 cosine floor - 2%. A full pair
-- pass is roughly $0.35. Triples are the danger: extending every positive pair
-- across the corpus is thousands of calls and would clear the $1/day ceiling
-- on its own, so the detector must extend only pairs that came back positive
-- and must respect the same pipeline_daily_usage cap ai-worker already checks.

-- A fact somebody has decided is worth protecting. Written by a human, which
-- is the honest limitation of the whole mechanism: the gate protects what
-- someone anticipated, not everything that could be derived.
create table if not exists public.protected_facts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  statement      text not null,
  classification smallint not null default 3 check (classification between 0 and 3),
  -- Optional hint at where this fact lives, in the same identifier space as
  -- permission_scope, so detection can narrow before it starts comparing.
  scope_hint     text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists idx_protected_facts_tenant
  on public.protected_facts (tenant_id);

-- The output of offline detection: a MINIMAL sufficient set of records that
-- together imply the fact. Minimal matters - if a subset already suffices, the
-- superset is noise, and repairing against it would withhold more than it has
-- to. A fact may have many independent derivation sets.
create table if not exists public.derivation_sets (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  fact_id      uuid not null references public.protected_facts(id) on delete cascade,
  decision_ids uuid[] not null,
  confidence   real not null default 0,
  detected_at  timestamptz not null default now()
);
create index if not exists idx_derivation_sets_fact
  on public.derivation_sets (tenant_id, fact_id);

-- Every time the gate fires: which fact it protected, which set covered it,
-- what repair dropped. Readable only with can_view_audit, because the log is
-- itself a disclosure - a list of what was withheld from someone is a map of
-- what there is to find.
--
-- This is also the single most useful artefact the design produces. For the
-- research it is the measurement; for an enterprise conversation it is the
-- evidence that the thing works.
create table if not exists public.gate_firings (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,
  fact_id       uuid references public.protected_facts(id) on delete set null,
  set_id        uuid references public.derivation_sets(id) on delete set null,
  -- What retrieval had produced, and what was removed to break the cover.
  candidate_ids uuid[] not null default '{}',
  withheld_ids  uuid[] not null default '{}',
  question_hash text,
  fired_at      timestamptz not null default now()
);
create index if not exists idx_gate_firings_tenant
  on public.gate_firings (tenant_id, fired_at desc);

-- Same closed posture as the roles tables: locus_app lane only, no
-- `authenticated` policy, no PostgREST grants.
do $$
declare t text;
begin
  foreach t in array array['protected_facts', 'derivation_sets', 'gate_firings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation_%I on public.%I', t, t);
    execute format(
      'create policy tenant_isolation_%I on public.%I for all using (tenant_id = nullif(current_setting(%L, true), %L)::uuid)',
      t, t, 'app.current_tenant_id', ''
    );
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
