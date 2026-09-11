-- Closes the "no observability" gap. Until now the only per-request number
-- the system emitted was metadata.latency_ms (hardcoded to 0 until this
-- week), and nothing collected it - so every performance question was
-- answered by reasoning about the code rather than measuring it.
--
-- One row per request, with the per-stage breakdown in jsonb rather than a
-- row per stage: "what's the p95 of /search" is the question that actually
-- gets asked, and that's a single scan here instead of a group-by. The
-- stage detail is still there when a slow request needs taking apart.
--
-- Deliberately not an APM vendor yet. This costs one insert per request and
-- answers the questions we actually have; picking a vendor is a decision
-- worth making with a week of real data in hand rather than before it.

create table public.request_traces (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade,
  route       text not null,
  total_ms    integer not null,
  stages      jsonb not null default '{}',
  ok          boolean not null default true,
  error       text,
  created_at  timestamptz not null default now()
);

create index idx_request_traces_route_time on public.request_traces (route, created_at desc);
create index idx_request_traces_tenant_time on public.request_traces (tenant_id, created_at desc);

alter table public.request_traces enable row level security;
alter table public.request_traces force row level security;

-- Operational telemetry, not tenant data: written by the trusted locus_app
-- role, read by whoever is debugging. No authenticated-role policy - a user
-- has no reason to read timing rows, and stage timings across tenants are
-- exactly the sort of thing that shouldn't leak sideways.
drop policy if exists tenant_isolation_request_traces on public.request_traces;
create policy tenant_isolation_request_traces on public.request_traces
  using (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid);
