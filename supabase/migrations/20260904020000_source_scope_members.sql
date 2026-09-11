-- Closes the "permissions fail open" gap: isDecisionAccessible() currently
-- ends `return decision.permission_scope.every(isUnmappedScope)` - i.e. a
-- decision scoped only to Slack channel IDs nobody has membership data for
-- is granted to EVERY member of the tenant. It has to guess because there
-- has never been a table telling it who is actually in a channel. This is
-- that table.
--
-- member_email, not a Slack user id, on purpose: resolvePermissionScopes()
-- (see _shared/tenantAuth.ts) returns workspace ids plus the caller's own
-- login email, so email is the only identifier the permission comparison
-- can actually match on today.
--
-- Deliberately NOT a hard cutover. The check treats a scope with zero rows
-- here as "no data yet" and keeps the old permissive behaviour for it;
-- only a scope we have really synced can deny anyone. That way deploying
-- this can never hide content that people are currently, correctly seeing -
-- coverage tightens as the sync fills in, rather than all at once.

create table public.source_scope_members (
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  source             text not null,
  external_scope_id  text not null,
  member_email       text not null,
  last_synced_at     timestamptz not null default now(),
  primary key (tenant_id, source, external_scope_id, member_email)
);

create index idx_source_scope_members_lookup
  on public.source_scope_members (tenant_id, external_scope_id, lower(member_email));

alter table public.source_scope_members enable row level security;
alter table public.source_scope_members force row level security;

-- Same convention as memberships/invites: no authenticated-role policies at
-- all. Only the trusted locus_app role (withTenant) and the service role
-- read or write this - a member must never be able to enumerate who else is
-- in a channel, or edit their own way into one.
drop policy if exists tenant_isolation_source_scope_members on public.source_scope_members;
create policy tenant_isolation_source_scope_members on public.source_scope_members
  using (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid);
