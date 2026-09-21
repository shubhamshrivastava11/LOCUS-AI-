-- The rules engine: classification rules, then routing rules.
--
-- Both are configuration, not code. The design note this implements set a
-- deliberate ceiling on that: no branching, no loops, no expression language.
-- A routing rule with conditions and derived records is already a small
-- workflow engine, and workflow engines grow until they need a UI, a
-- debugger, a dry-run mode and a version history. If a customer ever needs
-- branching, that is the signal to integrate a real workflow tool rather than
-- to grow one here.
--
-- Nothing in this migration changes how access is decided. Classification
-- rules feed the SAME max() floor that scope_classification_floors already
-- feeds, so a rule can raise a record's sensitivity and can never lower it.
-- Routing rules create new records; they never widen an existing one.

-- == Classification rules ===============================================

create table if not exists public.classification_rules (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  -- Null means tenant-wide. A department id narrows the rule to records whose
  -- scope belongs to that department.
  department_id uuid references public.departments(id) on delete cascade,

  name          text not null,

  -- Two match kinds and no more. `always` is the department-wide floor
  -- expressed as a rule so there is one evaluation path rather than two.
  -- `contains_any` is a case-insensitive substring test against the record
  -- text. Regex is deliberately absent: a catastrophically backtracking
  -- pattern in a tenant-editable field is a denial of service against our own
  -- ingestion, and nothing asked for so far needs one.
  match_type    text not null check (match_type in ('always', 'contains_any')),
  match_terms   text[] not null default '{}',

  -- The floor this rule imposes when it matches.
  set_classification smallint not null check (set_classification between 0 and 3),

  -- Optional compartment. At Confidential the compartment is the authority
  -- rather than the rank, so a rule that raises a record to 3 without naming
  -- one produces a record nobody can read - which fails closed, correctly,
  -- but is almost never what was meant. Checked below.
  set_compartment text,

  priority      int not null default 100,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),

  -- contains_any with no terms would match nothing and quietly do nothing,
  -- which is worse than being refused at write time.
  constraint classification_rules_terms_present
    check (match_type <> 'contains_any' or cardinality(match_terms) > 0),

  -- Raising to Confidential without a compartment makes the record
  -- unreadable by everyone including its author. Allowed only explicitly,
  -- by naming a compartment.
  constraint classification_rules_confidential_needs_compartment
    check (set_classification < 3 or set_compartment is not null)
);

create index if not exists idx_classification_rules_tenant
  on public.classification_rules (tenant_id, enabled, priority);

-- == Routing rules ======================================================

create table if not exists public.routing_rules (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  name               text not null,

  from_department_id uuid not null references public.departments(id) on delete cascade,
  to_department_id   uuid not null references public.departments(id) on delete cascade,

  -- Conditions. All optional, ANDed. No OR and no nesting, on purpose.
  when_record_type       text,
  when_min_classification smallint check (when_min_classification between 0 and 3),

  -- What the derived record is classified as in the destination.
  emit_classification smallint not null check (emit_classification between 0 and 3),

  -- The allowlist. Fields not named here do not cross, full stop. An
  -- allowlist rather than a denylist because a denylist fails the first time
  -- somebody puts a name in a field nobody thought to exclude, and that
  -- failure is silent.
  carry_fields text[] not null,

  -- Why this crossing is lawful. GDPR treats each processing purpose as
  -- needing its own basis, so a record that moved between departments has to
  -- be able to say WHY, not merely that it did. Not nullable: a rule that
  -- cannot state its purpose should not exist.
  purpose text not null,

  enabled    boolean not null default true,
  created_at timestamptz not null default now(),

  -- A rule pointing at its own department is a loop with extra steps.
  constraint routing_rules_distinct_departments
    check (from_department_id <> to_department_id),

  constraint routing_rules_allowlist_present
    check (cardinality(carry_fields) > 0),

  constraint routing_rules_purpose_meaningful
    check (length(btrim(purpose)) >= 8)
);

create index if not exists idx_routing_rules_tenant
  on public.routing_rules (tenant_id, enabled, from_department_id);

-- A derived record names the rule that made it. The column already exists;
-- this is the reference that makes it verifiable rather than decorative.
alter table public.decisions drop constraint if exists decisions_routed_by_rule_fk;
alter table public.decisions add constraint decisions_routed_by_rule_fk
  foreign key (routed_by_rule) references public.routing_rules(id) on delete set null;

-- == Routing audit ======================================================

-- Answers the question backwards: not "what did we send" but "why can this
-- person see this". Separate from the decisions row because the row can be
-- deleted and the audit should outlive it.
create table if not exists public.routing_audit (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  rule_id            uuid,
  rule_name          text not null,
  source_decision_id uuid,
  derived_decision_id uuid,
  from_department    text not null,
  to_department      text not null,
  purpose            text not null,
  source_classification smallint not null,
  emitted_classification smallint not null,
  carried_fields     text[] not null,
  -- Field names present on the source that the allowlist excluded. Recorded
  -- so an auditor can see what was withheld, without recording the values.
  withheld_fields    text[] not null default '{}',
  created_at         timestamptz not null default now()
);

create index if not exists idx_routing_audit_source
  on public.routing_audit (tenant_id, source_decision_id);

-- == RLS ================================================================

alter table public.classification_rules enable row level security;
alter table public.classification_rules force  row level security;
alter table public.routing_rules        enable row level security;
alter table public.routing_rules        force  row level security;
alter table public.routing_audit        enable row level security;
alter table public.routing_audit        force  row level security;

-- Rules are readable by the tenant lane so the UI can show them. The audit
-- is NOT: it names source records the reader may have no clearance for, so
-- it is admin-lane only and surfaces through an endpoint that checks
-- can_view_audit rather than through a table policy that cannot.
drop policy if exists classification_rules_select_tenant on public.classification_rules;
create policy classification_rules_select_tenant on public.classification_rules
  for select to locus_app
  using (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

drop policy if exists routing_rules_select_tenant on public.routing_rules;
create policy routing_rules_select_tenant on public.routing_rules
  for select to locus_app
  using (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

grant select on public.classification_rules to locus_app;
grant select on public.routing_rules        to locus_app;
-- routing_audit: no grant, no policy. Admin lane only, by design.
