-- Team invites: lets a tenant owner/admin bring a second person into their
-- EXISTING tenant instead of every signup always getting a brand-new solo
-- one (handle_new_user() is unchanged - invited members never go through
-- the early-access allowlist gate; being invited by an already-approved
-- owner is itself the authorization).
--
-- Same RLS convention as public.memberships/public.tenants (see
-- 20260718000000_rls_tenant_isolation.sql): RLS enabled + forced, zero
-- authenticated-role policies. Every read/write goes through the
-- service-role team-invites Edge Function, never a direct client call -
-- this table is never meant to be reachable via PostgREST directly.

create table public.invites (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  email        text not null,
  role         text not null check (role in ('admin', 'member')), -- no direct owner invites
  invited_by   uuid not null references auth.users(id),
  token        text not null unique,
  status       text not null default 'pending'
               check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- Only one pending invite per (tenant, email) at a time - a second invite
-- to the same address while one's still outstanding should revoke/reuse
-- the existing row, not create a duplicate.
create unique index invites_pending_unique on public.invites (tenant_id, lower(email)) where status = 'pending';
create index idx_invites_tenant on public.invites(tenant_id);
create index idx_invites_token on public.invites(token);

alter table public.invites enable row level security;
alter table public.invites force row level security;
