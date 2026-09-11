-- Real bug found by actually testing the team-invite flow: a teammate's
-- connections showed up in every other member's Settings with no way to
-- tell whose they were, and a fully working Disconnect button on them -
-- source_connections never recorded WHO connected a given source, and its
-- end-user RLS policy let any tenant member manage any other member's
-- connection. Read access stays tenant-wide on purpose (everyone should
-- still SEE the full list of what's connected - that's the point of a
-- shared team memory); only management (insert/update/delete) is scoped.

alter table public.source_connections add column connected_by uuid references auth.users(id);

-- Deliberately left null for every pre-existing row - there's no way to
-- know who actually connected something before this column existed, and a
-- guessed backfill would be worse than an honest unknown. Treated the same
-- as "anyone can still manage it" below, so this never locks anyone out of
-- a connection that predates this migration.

drop policy if exists tenant_isolation_source_connections_authenticated on public.source_connections;

create policy source_connections_select_authenticated on public.source_connections
  for select
  to authenticated
  using (
    tenant_id in (select m.tenant_id from public.memberships m where m.user_id = auth.uid())
  );

create policy source_connections_insert_authenticated on public.source_connections
  for insert
  to authenticated
  with check (
    tenant_id in (select m.tenant_id from public.memberships m where m.user_id = auth.uid())
    and connected_by = auth.uid()
  );

create policy source_connections_update_authenticated on public.source_connections
  for update
  to authenticated
  using (
    connected_by = auth.uid()
    or connected_by is null
    or exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid() and m.tenant_id = source_connections.tenant_id and m.role in ('owner', 'admin')
    )
  )
  with check (
    tenant_id in (select m.tenant_id from public.memberships m where m.user_id = auth.uid())
  );

create policy source_connections_delete_authenticated on public.source_connections
  for delete
  to authenticated
  using (
    connected_by = auth.uid()
    or connected_by is null
    or exists (
      select 1 from public.memberships m
      where m.user_id = auth.uid() and m.tenant_id = source_connections.tenant_id and m.role in ('owner', 'admin')
    )
  );

-- tenant_isolation_source_connections (the locus_app-role policy Edge
-- Functions use via withTenant()) is untouched - trusted backend role,
-- inserts go through application code below, not raw client access.
