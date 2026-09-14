-- Daily token accounting and a spend ceiling for the main pipeline.
--
-- loci-chat has had a daily cap since it shipped (LOCI_DAILY_SPEND_CAP_USD),
-- but that only covers the chat widget. ai-worker and the search path - which
-- is where essentially all the spend actually is - had no accounting at all
-- and no ceiling. Nobody could answer "what did yesterday cost" except by
-- opening the Anthropic console.
--
-- Steady state is not the problem. Measured 14 Sep 2026: 22.4 raw_events/day,
-- ~2 decisions/day, ~1 search/day, which is roughly $0.15/day at Haiku 4.5
-- rates. The problem is a burst. ai-worker drains 40 messages a minute on a
-- one-minute cron, so a large Gmail backfill can put ~57,000 events a day
-- through extraction, and each one is a Claude call. That is three orders of
-- magnitude over a $1/day budget, reached without anything being broken.
--
-- Global rather than per-tenant, because the budget being protected is the
-- Anthropic bill, which is not a per-tenant quantity.
--
-- RLS is enabled and forced with NO policy, which is deny-all for any role
-- without BYPASSRLS. That is deliberate and the same posture as the loci_*
-- tables: this is operational data with no tenant to scope it to, written and
-- read only through withAdmin(). Documented here because a policy-less RLS
-- table looks like an oversight to anyone who has not read this comment.

create table public.pipeline_daily_usage (
  usage_date                   date primary key,
  input_tokens                 bigint not null default 0,
  output_tokens                bigint not null default 0,
  cache_creation_input_tokens  bigint not null default 0,
  cache_read_input_tokens      bigint not null default 0,
  request_count                integer not null default 0
);

alter table public.pipeline_daily_usage enable row level security;
alter table public.pipeline_daily_usage force row level security;
