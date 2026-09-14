-- Brings five tables in line with the posture every other table here uses:
-- RLS both ENABLED and FORCED.
--
-- Honest about what this does and does not do. All five are owned by
-- postgres, which holds BYPASSRLS, and BYPASSRLS beats FORCE - so today this
-- changes no query's behaviour. It matters if ownership ever moves to a role
-- without that attribute, which is exactly the kind of change nobody
-- remembers to audit the policy posture for.
--
-- Worth recording what was found while checking, because it is load-bearing
-- and was nowhere written down:
--
--   decision_conflicts, radar_corrections
--     One policy each, on the locus_app lane (app.current_tenant_id). No
--     authenticated-role policy, and none needed - the frontend never reads
--     either table directly (verified: zero client-side reads).
--
--   loci_conversations, loci_daily_usage, loci_rate_limits
--     RLS enabled with ZERO policies, which is deny-all for any role without
--     BYPASSRLS. That is deliberate, not an oversight: the Loci widget is
--     anonymous, there is no tenant context to isolate by, and every access
--     goes through withAdmin(). The trap is that it is invisible - switching
--     loci-chat to withTenant() would make these queries silently return
--     nothing rather than error. If that refactor is ever made, policies have
--     to be written first.

alter table public.decision_conflicts force row level security;
alter table public.radar_corrections force row level security;
alter table public.loci_conversations force row level security;
alter table public.loci_daily_usage force row level security;
alter table public.loci_rate_limits force row level security;
