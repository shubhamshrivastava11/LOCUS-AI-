-- Server-side OAuth state, replacing a forgeable client-side blob.
--
-- Finding 03 of the 14 Sep 2026 review, confirmed. State was:
--
--     btoa(JSON.stringify({ t: tenantId, u: userId, o: redirectOrigin }))
--
-- Unsigned, so anyone could write one. Worse, parseTenantState's catch block
-- accepted a BARE TENANT UUID as valid state, so `?state=<tenant-uuid>` was
-- enough - no encoding needed at all.
--
-- /authorize was never the weak point: it verifies the access token and calls
-- assertMembership. The weakness is that /callback trusted the state it was
-- handed, so an attacker simply never visited /authorize. Complete a provider
-- flow with your own account, hand back a state naming somebody else's tenant,
-- and the connection - with your credentials and your cursor_state - is written
-- into their workspace. For Teams that is worse still, because the callback
-- then acts with the application's Graph privileges.
--
-- Fixed by making state an opaque server-issued handle that carries no
-- information and cannot be guessed: a random uuid whose meaning lives here.
-- Consuming it is a single atomic UPDATE, so it is single-use by construction
-- rather than by a check-then-act that two concurrent callbacks could both
-- pass.
--
-- source is stored and re-checked at consume: a state minted for one provider
-- must not be redeemable at another's callback.
--
-- RLS enabled and forced with no policy - deny-all for any role without
-- BYPASSRLS. Deliberate, and the same posture as pipeline_daily_usage: at
-- /callback the tenant is not yet known (that is what the state is FOR), so
-- the lookup cannot be tenant-scoped and must go through withAdmin.

create table public.oauth_states (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  -- Nullable to match source_connections.connected_by, which has always
  -- tolerated a null for rows created before attribution existed.
  user_id         uuid,
  source          text not null,
  redirect_origin text not null,
  sync_mode       text not null default 'full' check (sync_mode in ('full', 'new')),
  created_at      timestamptz not null default now(),
  consumed_at     timestamptz
);

-- Supports both the expiry predicate on consume and the opportunistic sweep.
create index idx_oauth_states_created on public.oauth_states (created_at);

alter table public.oauth_states enable row level security;
alter table public.oauth_states force row level security;
