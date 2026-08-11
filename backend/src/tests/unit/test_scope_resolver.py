"""
Unit tests for modules.permissions.scope_resolver.resolve_permission_scopes().

Proves the resolver derives scopes from the authenticated TenantContext's
own linked auth email, PLUS every active Gmail source_connections row
within the caller's own tenant (never from request input, and never
crossing a tenant boundary - see the function's own docstring for why this
second source doesn't broaden the security model beyond what Slack/Notion
already get via is_decision_accessible()'s unmapped-scope fallback).
"""
from __future__ import annotations
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.dependencies import TenantContext
from modules.permissions.scope_resolver import resolve_permission_scopes


def _mock_admin_pool(email: str | None, gmail_scopes: list[str] | None = None):
    mock_conn = AsyncMock()
    mock_conn.fetchval = AsyncMock(return_value=email)
    mock_conn.fetch = AsyncMock(
        return_value=[{"external_workspace_id": s} for s in (gmail_scopes or [])]
    )

    mock_acquire_cm = AsyncMock()
    mock_acquire_cm.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_acquire_cm.__aexit__ = AsyncMock(return_value=False)

    mock_pool = MagicMock()
    mock_pool.acquire = MagicMock(return_value=mock_acquire_cm)
    return mock_pool


class TestResolvePermissionScopes:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("role", ["member", "owner", "admin"])
    async def test_returns_callers_own_email_regardless_of_role(self, role):
        """role never changes the outcome - only the caller's own linked
        email does, since role is not (and must not become) an access-
        control predicate here."""
        ctx = TenantContext(user_id=str(uuid.uuid4()), tenant_id=str(uuid.uuid4()), role=role)
        with patch(
            "database.pool.get_admin_db_pool",
            return_value=_mock_admin_pool("person@example.com"),
        ):
            assert await resolve_permission_scopes(ctx) == ["person@example.com"]

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_email_resolvable(self):
        """No repository evidence supports inferring a scope beyond the
        caller's own identity - an unresolvable email means []."""
        ctx = TenantContext(user_id=str(uuid.uuid4()), tenant_id=str(uuid.uuid4()), role="member")
        with patch("database.pool.get_admin_db_pool", return_value=_mock_admin_pool(None)):
            assert await resolve_permission_scopes(ctx) == []

    @pytest.mark.asyncio
    async def test_different_callers_get_their_own_distinct_scope(self):
        """Each caller is scoped to their own identity, not to a shared or
        tenant-wide value."""
        ctx_a = TenantContext(user_id=str(uuid.uuid4()), tenant_id=str(uuid.uuid4()), role="member")
        ctx_b = TenantContext(user_id=str(uuid.uuid4()), tenant_id=str(uuid.uuid4()), role="owner")

        with patch("database.pool.get_admin_db_pool", return_value=_mock_admin_pool("a@example.com")):
            scopes_a = await resolve_permission_scopes(ctx_a)
        with patch("database.pool.get_admin_db_pool", return_value=_mock_admin_pool("b@example.com")):
            scopes_b = await resolve_permission_scopes(ctx_b)

        assert scopes_a == ["a@example.com"]
        assert scopes_b == ["b@example.com"]
        assert scopes_a != scopes_b

    @pytest.mark.asyncio
    async def test_includes_tenant_scoped_active_gmail_connections(self):
        """Regression test for the Gmail permission-scope bug: a caller whose
        login email differs from a Gmail account connected within their OWN
        tenant must still get that Gmail account's email as a scope, so
        decisions ingested from it (permission_scope=[that email]) become
        visible - this is the exact mismatch that made Gmail-sourced search
        results disappear (login=lakshmanrajith777@gmail.com, connected
        Gmail=rajith16777@gmail.com, same tenant)."""
        ctx = TenantContext(user_id=str(uuid.uuid4()), tenant_id=str(uuid.uuid4()), role="owner")
        with patch(
            "database.pool.get_admin_db_pool",
            return_value=_mock_admin_pool(
                "lakshmanrajith777@gmail.com", gmail_scopes=["rajith16777@gmail.com"]
            ),
        ):
            scopes = await resolve_permission_scopes(ctx)
        assert set(scopes) == {"lakshmanrajith777@gmail.com", "rajith16777@gmail.com"}

    @pytest.mark.asyncio
    async def test_gmail_scopes_without_a_resolvable_login_email(self):
        """A caller with no resolvable auth email (edge case already handled
        pre-fix) still gets their tenant's connected Gmail scopes - the two
        sources are independent, neither gates the other."""
        ctx = TenantContext(user_id=str(uuid.uuid4()), tenant_id=str(uuid.uuid4()), role="member")
        with patch(
            "database.pool.get_admin_db_pool",
            return_value=_mock_admin_pool(None, gmail_scopes=["someone@gmail.com"]),
        ):
            scopes = await resolve_permission_scopes(ctx)
        assert scopes == ["someone@gmail.com"]
