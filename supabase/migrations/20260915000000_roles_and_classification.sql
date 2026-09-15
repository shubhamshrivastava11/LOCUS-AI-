-- Two new dimensions of access control: seniority, and sensitivity.
--
-- Until now Locus enforced on exactly one axis - scope. A record carries a
-- permission_scope array of Slack channel and Notion page ids, and a caller
-- sees it if their resolved scopes intersect. That is correct and it is
-- incomplete: everybody in a channel sees everything in that channel, whether
-- they are the intern or the founder, and nothing distinguishes "we moved the
-- standup to 10am" from "we are letting someone go".
--
-- This adds the vertical axis (role_level, five ordered levels) and the
-- sensitivity axis (classification, four ordered levels). They are enforced as
-- an AND alongside the existing scope check, never as an override. The
-- consequence is worth stating because the word "hierarchy" invites the
-- opposite assumption: a higher role does not widen what you can reach. It
-- only lets you see more sensitive material inside places you already belong.
-- An Owner who is not in a private channel sees nothing from it, at any
-- classification. Seniority buys clearance, never scope.
--
-- SHIP DAY IS A NO-OP. Every existing membership keeps the role it already
-- has, and every existing record defaults to Internal, which Member clearance
-- already covers. Verified against production before writing this: 7
-- memberships, all 'owner'; 256 decisions. Nothing becomes less visible than
-- it is today, and nothing becomes more visible. The system only tightens
-- later, deliberately, through promotion and classification.

-- == Part 1. The five-role hierarchy ======================================

-- The spec this implements proposed a new `role_level smallint` column. It is
-- not added as an independent column, because memberships.role already exists
-- and is already the authority: team-invites reads it to decide who may
-- invite, delete-account reads it to find the owner, capture-source-rules
-- gates on it, and it is minted into the MCP JWT. Two columns both claiming to
-- encode seniority is how they drift, and the drift is silent until someone is
-- an 'admin' at level 2.
--
-- So role stays the single source of truth and role_level is GENERATED from
-- it. Ordering comes for free - level comparisons are what the whole access
-- rule is built on - and disagreement between the two is not merely
-- discouraged, it is unrepresentable.
alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check
  check (role in ('owner', 'admin', 'lead', 'member', 'guest'));

alter table public.memberships
  add column if not exists role_level smallint
    generated always as (
      case role
        when 'owner'  then 5
        when 'admin'  then 4
        when 'lead'   then 3
        when 'member' then 2
        when 'guest'  then 1
        else 2
      end
    ) stored;

-- The lesson from Slack, which publicly acknowledged that one broad Admin role
-- handed people permissions unrelated to their responsibility and later split
-- it into narrow system roles: where a narrow capability is needed
-- independently of seniority, add a flag rather than promoting someone. The IT
-- administrator who has to wire up Jira does not need to read everyone's
-- decisions. Two flags are enough to start.
alter table public.memberships
  add column if not exists can_manage_connectors boolean not null default false,
  add column if not exists can_view_audit        boolean not null default false,
  add column if not exists expires_at            timestamptz;

-- expires_at is the Guest mechanism specifically. Constrained rather than left
-- as a column other roles may set and nothing reads, which is the kind of
-- half-wired field that later gets trusted by mistake.
alter table public.memberships drop constraint if exists memberships_expiry_guest_only;
alter table public.memberships add constraint memberships_expiry_guest_only
  check (expires_at is null or role = 'guest');

-- A Lead is a Lead of something. Without an explicit owner the role would
-- apply tenant-wide, which is the blast radius the level split exists to
-- avoid. scope_id is deliberately the same identifier permission_scope already
-- carries - a Slack channel id or a Notion page id - because the scope is the
-- natural container and it already exists.
create table if not exists public.scope_owners (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  scope_id   text not null,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tenant_id, scope_id, user_id)
);

-- == Part 2. The classification dimension ================================

-- Scope answers "where did this come from". Classification answers "how
-- sensitive is it". They are independent: a record in a public channel can be
-- sensitive, and a record in a private channel can be routine.
--
--   0 Public       safe for anyone in the tenant, Guests included
--   1 Internal     ordinary operational record - THE DEFAULT
--   2 Restricted   personnel, compensation, unreleased commercial, security
--   3 Confidential legal exposure, acquisitions, individual performance
--
-- Escalation is automatic, de-escalation is manual. If the extraction model
-- proposes a level above Internal it is applied immediately; lowering one
-- requires a Lead or Admin and lands in classification_audit. Fail closed on
-- the way up, require a human on the way down.
alter table public.decisions
  add column if not exists classification smallint not null default 1,
  add column if not exists classified_by  text     not null default 'default',
  add column if not exists classified_at  timestamptz;

alter table public.decisions drop constraint if exists decisions_classification_range;
alter table public.decisions add constraint decisions_classification_range
  check (classification between 0 and 3);

alter table public.decisions drop constraint if exists decisions_classified_by_source;
alter table public.decisions add constraint decisions_classified_by_source
  check (classified_by in ('default', 'model', 'user', 'scope_floor'));

create index if not exists idx_decisions_classification
  on public.decisions (tenant_id, classification);

-- A Lead can set a floor for a scope, so everything out of a private HR
-- channel starts at Restricted no matter what the model proposes. The floor
-- raises, never lowers: it is a max() against the model's proposal, so setting
-- a floor can never make a record more visible than it already was.
create table if not exists public.scope_classification_floors (
  tenant_id  uuid     not null references public.tenants(id) on delete cascade,
  scope_id   text     not null,
  floor      smallint not null check (floor between 0 and 3),
  set_by     uuid     references auth.users(id) on delete set null,
  set_at     timestamptz not null default now(),
  primary key (tenant_id, scope_id)
);

-- Every de-escalation, permanently. This is the half of the classification
-- story that has to be reviewable: escalation is cheap and automatic, so the
-- only interesting event is a human deciding something is less sensitive than
-- the system thought.
create table if not exists public.classification_audit (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  decision_id uuid not null,
  from_level  smallint not null,
  to_level    smallint not null,
  changed_by  uuid references auth.users(id) on delete set null,
  reason      text,
  changed_at  timestamptz not null default now()
);
create index if not exists idx_classification_audit_tenant
  on public.classification_audit (tenant_id, changed_at desc);

-- == Clearance is necessary but not sufficient at the top ================

-- Levels 0 to 2 fall out of role clearance combined with scope. Level 3,
-- Confidential, additionally requires an explicit grant. Holding Admin does
-- not by itself admit someone to acquisition discussions or individual
-- performance records.
--
-- Per scope, never tenant-wide, and that is the point: this is the standard
-- clearance-plus-compartment arrangement, which is the operational form of
-- the distinction the whole design is about. Being permitted to access
-- something is not the same as needing to know it.
create table if not exists public.confidential_grants (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  scope_id   text not null,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key (tenant_id, user_id, scope_id)
);

-- == RLS =================================================================

-- Same posture as every other tenant-scoped table: the locus_app lane via the
-- transaction-local app.current_tenant_id GUC, and nothing else. No
-- `authenticated` policy is added, deliberately - see the companion migration
-- that closes that lane for content tables. A PostgREST connection has no such
-- GUC set, so NULLIF returns null, the qual is false, and these deny.
do $$
declare t text;
begin
  foreach t in array array[
    'scope_owners', 'scope_classification_floors',
    'classification_audit', 'confidential_grants'
  ] loop
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
