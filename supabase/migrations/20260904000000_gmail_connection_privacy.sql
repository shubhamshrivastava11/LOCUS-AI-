-- Real distinction the team-invite/attribution work surfaced: Slack,
-- ClickUp, Jira, etc. represent a shared TEAM resource (the whole point of
-- 20260901160000's tenant-wide select policy - everyone should see the
-- team's Slack is connected). Gmail is different - it's one person's
-- personal inbox, not a team resource, and a teammate seeing "so-and-so's
-- Gmail is connected" in Settings isn't the same kind of transparency.
-- Scopes SELECT on gmail rows specifically to the connecting person
-- (or owner/admin, for real account oversight) - every other source's
-- visibility is unchanged.

drop policy if exists source_connections_select_authenticated on public.source_connections;

create policy source_connections_select_authenticated on public.source_connections
  for select
  to authenticated
  using (
    tenant_id in (select m.tenant_id from public.memberships m where m.user_id = auth.uid())
    and (
      source <> 'gmail'
      or connected_by = auth.uid()
      or connected_by is null
      or exists (
        select 1 from public.memberships m
        where m.user_id = auth.uid() and m.tenant_id = source_connections.tenant_id and m.role in ('owner', 'admin')
      )
    )
  );
