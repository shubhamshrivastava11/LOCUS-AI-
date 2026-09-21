-- Two changes, both groundwork for cross-department routing.
--
-- 1. `guest` becomes `external`. Same level, same clearance, same expiry
--    mechanism, same hard floor at Confidential. Only the name changes, and
--    it changes because the capability is a contractor or auditor seat and
--    "Guest" reads like a consumer app. Nothing about the access rule moves.
--
-- 2. Departments: a named set of scopes. Today a scope is a Slack channel or
--    a Notion space, which is incidental rather than organisational - nothing
--    says #hiring-leads belongs to HR, and nothing stops someone renaming it.
--    A routing rule needs a boundary it can name and that survives a reorg.
--
-- Deliberately NOT in this migration: the rules engine, routing, or any
-- change to how access is decided. This adds vocabulary. The access rule is
-- untouched, so the six role-visibility baselines must come out identical
-- afterwards - that is the check that this migration did nothing it should
-- not have.

-- == Part 1. guest -> external ==========================================

-- Order matters. The check constraint has to admit both spellings before any
-- row can be rewritten, and role_level is a generated column whose CASE
-- names the old value, so it has to be dropped before the rows change and
-- rebuilt afterwards. Doing this in the wrong order fails mid-transaction
-- against a live table.

alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check
  check (role in ('owner', 'admin', 'lead', 'member', 'guest', 'external'));

alter table public.memberships drop column if exists role_level;

alter table public.memberships
  drop constraint if exists memberships_expiry_guest_only;

update public.memberships set role = 'external' where role = 'guest';

-- Same table, same intent, new name: expiry belongs to the external seat and
-- to nothing else. Left as a constraint rather than a convention because a
-- column other roles may set and nothing reads is the kind of half-wired
-- field that later gets trusted by mistake.
alter table public.memberships drop constraint if exists memberships_expiry_external_only;
alter table public.memberships add constraint memberships_expiry_external_only
  check (expires_at is null or role = 'external');

-- An external seat with no expiry is a permanent outsider, which is the thing
-- the seat exists to prevent. Enforced now that no legacy rows can violate it.
alter table public.memberships drop constraint if exists memberships_external_must_expire;
alter table public.memberships add constraint memberships_external_must_expire
  check (role <> 'external' or expires_at is not null);

-- Now that no row says 'guest', the constraint can refuse it outright rather
-- than tolerating a spelling nothing writes.
alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check
  check (role in ('owner', 'admin', 'lead', 'member', 'external'));

alter table public.memberships
  add column role_level smallint
    generated always as (
      case role
        when 'owner'    then 5
        when 'admin'    then 4
        when 'lead'     then 3
        when 'member'   then 2
        when 'external' then 1
        else 2
      end
    ) stored;

-- Invites carry a role too, and an invite written before this migration could
-- otherwise mint a membership the memberships constraint now refuses.
update public.invites set role = 'external' where role = 'guest';

alter table public.invites drop constraint if exists invites_role_check;
alter table public.invites add constraint invites_role_check
  check (role in ('admin', 'lead', 'member', 'external'));

-- == Part 2. Departments ================================================

-- A department is a named set of scopes. That is the whole idea: the scope
-- check in the access rule already exists and already works, so a department
-- needs no new enforcement path - it is a label over scopes a rule can name.
create table if not exists public.departments (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  name                   text not null,
  -- What a record captured in this department starts at when no rule says
  -- otherwise. HR and Finance will want 2 (Restricted) rather than the
  -- global default of 1 (Internal), and that is the point of having it here
  -- rather than one global setting.
  default_classification smallint not null default 1
    check (default_classification between 0 and 3),
  created_at             timestamptz not null default now(),
  unique (tenant_id, name)
);

-- One scope belongs to at most one department. A channel in two departments
-- would make "which default classification applies" ambiguous, and an
-- ambiguous answer in a security model resolves to whichever row the planner
-- returned first. Primary key on scope_id alone within the tenant forbids it.
create table if not exists public.department_scopes (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  scope_id      text not null,
  department_id uuid not null references public.departments(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (tenant_id, scope_id)
);

create index if not exists idx_department_scopes_dept
  on public.department_scopes (department_id);

-- Membership of a department is NOT membership of its scopes, and does not
-- grant reach. It records who belongs where, so a rule can address "the
-- Finance lead" and an audit can answer "why was this person eligible".
-- Access still comes from scope membership and clearance, exactly as before.
create table if not exists public.department_members (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  is_head       boolean not null default false,
  created_at    timestamptz not null default now(),
  primary key (department_id, user_id)
);

create index if not exists idx_department_members_user
  on public.department_members (tenant_id, user_id);

-- == Part 3. RLS ========================================================

-- Enabled AND forced on all three, matching every other table here. Forced
-- matters: without it the table owner bypasses its own policies, which is
-- how a check that looks present turns out not to apply to the lane that
-- actually reads it.
alter table public.departments        enable row level security;
alter table public.departments        force  row level security;
alter table public.department_scopes  enable row level security;
alter table public.department_scopes  force  row level security;
alter table public.department_members enable row level security;
alter table public.department_members force  row level security;

-- Readable by the tenant lane, which resolves app.current_tenant_id per
-- transaction. Writes are admin-lane only and deliberately have no policy:
-- departments are configuration, and configuration changes through an
-- endpoint that checks a role, never through a direct client write.
drop policy if exists departments_select_tenant on public.departments;
create policy departments_select_tenant on public.departments
  for select to locus_app
  using (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

drop policy if exists department_scopes_select_tenant on public.department_scopes;
create policy department_scopes_select_tenant on public.department_scopes
  for select to locus_app
  using (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

drop policy if exists department_members_select_tenant on public.department_members;
create policy department_members_select_tenant on public.department_members
  for select to locus_app
  using (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

grant select on public.departments        to locus_app;
grant select on public.department_scopes  to locus_app;
grant select on public.department_members to locus_app;

-- == Part 4. Purpose and audit, added before the first rule exists ======

-- GDPR treats each processing purpose as needing its own basis, so a record
-- that crossed a department boundary has to be able to say WHY it crossed,
-- not merely that it did. Added now, while both tables are empty of routed
-- records, because retrofitting this over live data later is a migration
-- nobody will want to run.
alter table public.decisions
  add column if not exists source_decision_id uuid references public.decisions(id) on delete set null,
  add column if not exists routed_purpose     text,
  add column if not exists routed_by_rule     uuid;

-- A derived record names its source and its purpose, or it is neither.
alter table public.decisions drop constraint if exists decisions_routing_complete;
alter table public.decisions add constraint decisions_routing_complete
  check (
    (source_decision_id is null and routed_purpose is null and routed_by_rule is null)
    or
    (source_decision_id is not null and routed_purpose is not null and routed_by_rule is not null)
  );

create index if not exists idx_decisions_source
  on public.decisions (tenant_id, source_decision_id)
  where source_decision_id is not null;
