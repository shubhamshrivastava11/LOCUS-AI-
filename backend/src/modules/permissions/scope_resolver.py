"""
Permission Scope Resolver — the sole source of a caller's authorized
permission_scopes for /search. Never trust a request body for this: scopes
are authorization data, and a client asking for a scope is not evidence it
is entitled to it.

There is still no real per-user/per-channel ACL table anywhere in the
schema (memberships stores only tenant_id/user_id/role - nothing
scope-shaped), so this cannot grant broad, inferred scopes. What it can do
safely: the connectors (gmail-manual-sync/slack-webhook/notion-poller) set
a decision's permission_scope to an identifier the caller can independently
be shown to own - the connected Gmail account's own email address, for
example. Resolving the caller's own linked identifiers as their scope lets
them see decisions provably tied to their own connected accounts, without
inferring any broader (e.g. whole-channel, whole-workspace) access. Scopes
tied to identifiers not owned by the caller remain fails-closed exactly as
before.
"""
from __future__ import annotations

import uuid

from app.dependencies import TenantContext


async def resolve_permission_scopes(ctx: TenantContext) -> list[str]:
    """Return the caller's authorized permission_scopes, derived only from
    the authenticated TenantContext - never from request input.

    Two sources, both scoped to identifiers the caller can be shown to
    have a legitimate claim on:

    1. The caller's own auth email address, if resolvable - decisions
       scoped to their own connected account become visible to them.
    2. Every ACTIVE Gmail source_connections row within the caller's OWN
       tenant (ctx.tenant_id - already authenticated, never request
       input). source_connections has no per-connecting-user ownership
       column today (it's tenant-scoped only, not user-scoped), so this
       cannot verify "this specific teammate connected this specific
       inbox" - only "this Gmail account is connected within a tenant I
       am already a verified member of". That is exactly the granularity
       Slack/Notion decisions already get via is_decision_accessible()'s
       _is_unmapped_scope fallback (workspace-wide visibility for any
       tenant member, since no finer per-channel/per-page ACL exists
       either) - this brings Gmail in line with that existing model
       rather than introducing new exposure. It never crosses a tenant
       boundary: the explicit tenant_id predicate below is the only
       enforcement here (this query runs on the RLS-bypassing admin pool,
       same as the auth.users lookup already did), so ctx.tenant_id being
       server-derived and authenticated is what keeps this safe - it is
       never accepted from request input.

    Everything else - decisions with an empty scope (workspace-wide) - is
    already visible regardless, via is_decision_accessible()'s existing
    empty-scope-is-public rule.
    """
    from database.pool import get_admin_db_pool

    tenant_uuid = uuid.UUID(str(ctx.tenant_id))

    async with get_admin_db_pool().acquire() as conn:
        email = await conn.fetchval(
            "SELECT email FROM auth.users WHERE id = $1",
            uuid.UUID(ctx.user_id),
        )
        gmail_rows = await conn.fetch(
            """
            SELECT external_workspace_id
            FROM public.source_connections
            WHERE tenant_id = $1 AND source = 'gmail' AND status = 'active'
              AND external_workspace_id IS NOT NULL
            """,
            tenant_uuid,
        )

    scopes = {row["external_workspace_id"] for row in gmail_rows}
    if email:
        scopes.add(email)
    return list(scopes)
