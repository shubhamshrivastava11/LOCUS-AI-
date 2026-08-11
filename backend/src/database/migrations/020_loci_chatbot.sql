-- Loci: the Tsenta.com support/FAQ chatbot widget backend.
--
-- Deliberately NOT part of the Locus AI tenant model (no tenant_id, no RLS
-- policies tied to public.tenants) - Tsenta is an unrelated product sharing
-- this Supabase project purely to avoid a second project's compute cost.
-- RLS is enabled with zero policies so only the service_role connection
-- (withAdmin, see supabase/functions/_shared/db.ts) can touch these tables;
-- anon/authenticated get nothing.

create table if not exists public.loci_conversations (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists loci_conversations_session_idx
  on public.loci_conversations (session_id, created_at);

alter table public.loci_conversations enable row level security;

-- Fixed-window rate limiting, keyed by "ip:<addr>" or "session:<id>".
-- window_start resets to now() whenever the window has elapsed (checked in
-- application code, not a trigger - simpler, and the edge function already
-- holds the connection open for the check-and-increment).
create table if not exists public.loci_rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  request_count int not null default 0
);

alter table public.loci_rate_limits enable row level security;
