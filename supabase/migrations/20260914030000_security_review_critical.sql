-- Closes three access-control defects from the 14 Sep 2026 security review.
-- Each was verified against the live database before changing anything; the
-- review could not see production grants and flagged them as needing it.
--
-- ─────────────────────────────────────────────────────────────────────────
-- 02 (critical) search_decisions_fts is reachable by anon
--
-- Verified live:
--   secdef=true owner=postgres
--   acl= =X/postgres anon=X authenticated=X service_role=X locus_app=X
--
-- SECURITY DEFINER, owned by postgres (which holds BYPASSRLS), filtering only
-- on the p_tenant_id the CALLER passes in, with EXECUTE granted to PUBLIC and
-- anon. The anon key is compiled into the frontend bundle and is public by
-- design, so anyone holding it could call this over PostgREST with any tenant
-- id and read that tenant's decisions - RLS bypassed, Edge Function JWT checks
-- bypassed, no membership check anywhere in the path.
--
-- Only caller in the codebase is mcp/index.ts:198, which uses
-- getServiceClient() - service_role - so it keeps working. Nothing else calls
-- it, so the other grants buy nothing and cost everything.
--
-- search_path is pinned as well: an unqualified definer function is
-- hijackable by a caller-controlled search_path.

revoke execute on function public.search_decisions_fts(text, uuid, integer) from public;
revoke execute on function public.search_decisions_fts(text, uuid, integer) from anon;
revoke execute on function public.search_decisions_fts(text, uuid, integer) from authenticated;
alter function public.search_decisions_fts(text, uuid, integer) set search_path = public, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- 04 (critical) the browser can write integration identities
--
-- source_connections carried INSERT, UPDATE and DELETE policies for the
-- authenticated role, scoped only by tenant membership, with no column
-- restrictions. cursor_state is in that row, and cursor_state is where
-- github-poller reads installation_id - which _shared/githubAuth.ts then
-- treats as proof of authorization when minting an installation token with
-- the app's private key. A member could write an installation id belonging to
-- someone else and have Locus import it into their own tenant.
--
-- Verified: the frontend never writes this table. frontend/src/lib/
-- sourceConnections.ts only SELECTs a fixed column list, and disconnect goes
-- through the team-invites/connection Edge Function, not a direct delete. So
-- these three policies were unused by the product and purely an attack
-- surface.
--
-- The SELECT policy stays - fetchSourceConnections needs it. The remaining
-- tenant_isolation_source_connections policy is the locus_app lane, keyed on
-- app.current_tenant_id, which a browser session never has set, so writes are
-- now denied for authenticated by every policy on the table.

drop policy if exists source_connections_insert_authenticated on public.source_connections;
drop policy if exists source_connections_update_authenticated on public.source_connections;
drop policy if exists source_connections_delete_authenticated on public.source_connections;

-- ─────────────────────────────────────────────────────────────────────────
-- 09 (high) "Pause all learning" has never worked
--
-- tenants has RLS enabled AND forced, locus_app does not hold BYPASSRLS, and
-- the table's only policy - tenants_select_member - targets the authenticated
-- role. ai-worker reads the settings through withTenant(), which runs as
-- locus_app:
--
--   const rows = await sql`SELECT learning_paused FROM public.tenants ...`;
--   return rows.length > 0 && rows[0].learning_paused === true;
--
-- rows.length is therefore always 0, and isPaused is always false. Same for
-- core_knowledge_only at line 1231. Both controls are rendered in Settings >
-- Build Memory and neither has ever been enforced. One tenant currently has
-- core_knowledge_only = true and has been having everything captured.
--
-- Same shape as tenant_isolation_decisions: keyed on the transaction-local
-- GUC, so it grants nothing to a browser session, which never sets it.
-- SELECT only - workers read these settings, they do not write them.

drop policy if exists tenant_isolation_tenants_select on public.tenants;
create policy tenant_isolation_tenants_select on public.tenants
  for select
  using (id = nullif(current_setting('app.current_tenant_id', true), '')::uuid);
