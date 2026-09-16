-- Continuous assertions about the running system.
--
-- The gap this closes is not observability. admin-pipeline-status has reported
-- queue depths and triage counts for weeks, request_traces records per-stage
-- latency, and pipeline_daily_usage records every token. All of that is a
-- PULL: it answers a question when somebody thinks to ask one.
--
-- On 16 Sep 2026 every dashboard in production showed zero decisions for most
-- of a day. Nothing was down. The API returned 200, the queues were empty, the
-- worker was running, spend was normal, and every existing signal looked
-- healthy - because the fault was in the access rule, which answered "you may
-- see nothing" to everyone. It was found by a person opening the product and
-- noticing their data was gone.
--
-- What was missing is an ASSERTION: a statement about what the system should
-- be returning, checked continuously, that fails loudly when it stops being
-- true. This is the storage for those.
--
-- Design notes
-- ------------
-- health_checks holds one row per check - current state, last transition,
-- consecutive failures. It is a state table, not a log, so it stays tiny and
-- can be read at a glance.
--
-- health_events records only TRANSITIONS. A check that has been failing for
-- six hours is one row, not seventy-two. This is what makes the table useful
-- as an incident history rather than something nobody reads.
--
-- health_canary_baseline is the interesting one, and the reason the canary can
-- catch a regression in both directions. It records how many records each test
-- account is EXPECTED to see. Without a baseline a canary can only assert
-- "more than zero", which catches yesterday's failure and would completely
-- miss the opposite one: a clearance bug that shows everybody everything. With
-- a baseline, both are a mismatch.

create table if not exists public.health_checks (
  name              text primary key,
  status            text not null check (status in ('pass', 'warn', 'fail', 'unknown')),
  detail            text,
  -- Whatever the check measured, so a failure can be diagnosed from the row
  -- rather than by re-running it by hand at a different moment.
  observed          jsonb not null default '{}'::jsonb,
  consecutive_fails integer not null default 0,
  last_run_at       timestamptz not null default now(),
  -- When the status last CHANGED, which is the number that answers "how long
  -- has this been broken".
  changed_at        timestamptz not null default now(),
  duration_ms       integer
);

create table if not exists public.health_events (
  id           bigserial primary key,
  name         text not null,
  from_status  text,
  to_status    text not null,
  detail       text,
  observed     jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now(),
  -- Set once an alert for this transition has actually been delivered, so a
  -- retry cannot send the same alert twice and an undelivered one is visible.
  notified_at  timestamptz
);
create index if not exists idx_health_events_recent
  on public.health_events (occurred_at desc);

create table if not exists public.health_canary_baseline (
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  label            text not null,
  expected_visible integer not null,
  -- Re-baselining is a deliberate act with a reason attached. A canary whose
  -- baseline drifts silently to match whatever the system currently does is
  -- not a canary, it is a very slow way of writing down a bug.
  set_at           timestamptz not null default now(),
  note             text,
  primary key (tenant_id, user_id)
);

-- Operational data with no tenant to scope it to, written and read only
-- through withAdmin. RLS on and forced with no policy is deny-all for anything
-- without BYPASSRLS, which is the same deliberate posture as
-- pipeline_daily_usage. The baseline table references a tenant but is still
-- operational rather than customer-facing, so it gets the same treatment.
do $$
declare t text;
begin
  foreach t in array array['health_checks', 'health_events', 'health_canary_baseline'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
