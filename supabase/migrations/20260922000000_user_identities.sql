-- One person, several email addresses.
--
-- THE BUG THIS FIXES. Scope membership is matched by email string. Lam's
-- Locus account is lam.dao@cstu.edu and his Slack account is
-- dnlamvhit@gmail.com, so he matched no channel in his own workspace. All
-- three of his channels ARE synced, which makes them "known", and the known
-- branch fails closed - so he saw 0 of his 7 live records while the
-- dashboard looked like the product had simply lost his data.
--
-- It is worse than a blank screen: it appeared to WORK and then stopped.
-- Before slack-membership-sync populated the table those scopes were
-- unmapped and everything was visible. Filling the table in is what made
-- them disappear, which is the opposite of how a safety mechanism should
-- behave from the user's side, and there was nothing on screen or in
-- monitoring to say why.
--
-- The fix is not to weaken the rule. An owner who is genuinely not in a
-- channel still should not read it - that is the whole "seniority buys
-- clearance, never reach" property. The fix is to stop mistaking two
-- addresses for two people.

create table if not exists public.user_identities (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  email      text not null,
  -- Which connected system this address belongs to, or 'manual' when a
  -- person or admin asserted it. Recorded so a future identity-provider
  -- sync can replace what it owns without touching hand-entered rows.
  source     text not null default 'manual',
  created_at timestamptz not null default now()
);

-- Case-insensitive, because every comparison against member_email is.
create unique index if not exists uq_user_identities
  on public.user_identities (tenant_id, user_id, lower(email));

-- The reverse lookup the permission check actually performs.
create index if not exists idx_user_identities_email
  on public.user_identities (tenant_id, lower(email));

-- An address may only belong to ONE person within a tenant. Without this,
-- two accounts could both claim a Slack address and each inherit the
-- other's channel access, which is a privilege escalation dressed as a
-- convenience feature.
create unique index if not exists uq_user_identities_one_owner
  on public.user_identities (tenant_id, lower(email));

alter table public.user_identities enable row level security;
alter table public.user_identities force  row level security;

-- Tenant-scoped, and deliberately NOT also scoped to the calling user.
--
-- The first draft of this policy added
--   and user_id = current_setting('app.current_user_id', true)::uuid
-- which reads like tighter security and is in fact the 16 September outage
-- again. withTenant sets app.current_tenant_id and nothing else, so
-- current_setting would return null, `user_id = null` is never true, and
-- this table would return zero rows to every caller forever - the same
-- shape of failure as the memberships policy that hid every record from
-- everyone for most of a day.
--
-- Restricting to one user belongs in the query, not the policy, because the
-- lane cannot express it. That is safe here: locus_app is server-side code
-- and the browser has no grant on this table at all, so tenant scope is the
-- real boundary.
drop policy if exists user_identities_select_own on public.user_identities;
create policy user_identities_select_tenant on public.user_identities
  for select to locus_app
  using (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

grant select on public.user_identities to locus_app;

comment on table public.user_identities is
  'Additional email addresses a Locus user is known by in connected sources, '
  'so scope membership matches the person rather than one address.';
