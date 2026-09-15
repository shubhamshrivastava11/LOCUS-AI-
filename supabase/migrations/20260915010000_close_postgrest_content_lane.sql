-- Close the second door instead of fitting it with a second lock.
--
-- Locus has always had two paths into the same tables. The product path goes
-- through the Edge Functions as locus_app, with the tenant pinned by the
-- transaction-local app.current_tenant_id GUC, and that is where every
-- authorization check lives: scope intersection, the personal-source rule,
-- and now clearance. The other path is PostgREST, reached with the anon key
-- and a user's JWT, where the role is `authenticated` and the only thing
-- standing between a caller and a row is an RLS policy.
--
-- On four content tables that policy was `FOR ALL` qualified on nothing but
-- tenant membership:
--
--   tenant_isolation_decisions_authenticated
--   tenant_isolation_raw_events_authenticated
--   tenant_isolation_feedback_events_authenticated
--   tenant_isolation_mcp_tool_calls_authenticated
--
-- combined with grants of INSERT, SELECT, UPDATE and DELETE. So any signed-in
-- member could read every decision in their tenant straight over PostgREST,
-- ignoring permission_scope entirely - and rewrite or delete them too. Every
-- check in api/index.ts is a check on the door nobody has to use.
--
-- The roles design proposed mirroring the new clearance rule onto this lane.
-- That is the wrong repair for Locus, for a reason specific to this codebase:
-- nothing uses the lane. The only PostgREST reads the frontend performs are
-- memberships, early_access_allowlist, record_flags and source_connections,
-- each of which has its own narrow purpose-built policy and keeps it. Every
-- Edge Function connects with the service role. Mirroring would buy a
-- permanent obligation to keep a four-condition predicate identical in two
-- languages, to protect traffic that does not exist.
--
-- So: revoke the grants, drop the tenant-wide policies. The locus_app
-- tenant_isolation_* policies are untouched and remain the enforcement point.
-- If a future feature genuinely needs one of these tables client-side, it
-- should arrive with a narrow policy naming the exact columns and rows it
-- needs, the way record_flags did.

revoke all on public.decisions       from anon, authenticated;
revoke all on public.raw_events      from anon, authenticated;
revoke all on public.feedback_events from anon, authenticated;
revoke all on public.mcp_tool_calls  from anon, authenticated;

-- decision_embeddings holds the vectors for the same rows and had the same
-- blanket grants. There is no policy for `authenticated` on it at all, so the
-- grants were already inert - removing them keeps the table from becoming
-- readable the moment somebody adds a permissive policy without checking.
revoke all on public.decision_embeddings from anon, authenticated;

drop policy if exists tenant_isolation_decisions_authenticated       on public.decisions;
drop policy if exists tenant_isolation_raw_events_authenticated      on public.raw_events;
drop policy if exists tenant_isolation_feedback_events_authenticated on public.feedback_events;
drop policy if exists tenant_isolation_mcp_tool_calls_authenticated  on public.mcp_tool_calls;

-- Future tables inherit the closed posture rather than the open one. Supabase
-- ships default privileges that grant everything on new public tables to anon
-- and authenticated, which is how the four above came to be open without
-- anyone deciding they should be.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on tables from authenticated;
