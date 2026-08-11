"""
Integration tests for modules.search.router's POST /search (Phase 2
production search endpoint), through the real app.main ASGI app.

modules.search.service.vector_search() and .generate_answer() are mocked
at their modules.search.service import sites (no real Voyage/Anthropic/DB
call); permission filtering, scope resolution, and context building run
for real. Auth uses real issue_tenant_jwt()-signed tokens, matching the
pattern already established in tests/unit/test_retrieval.py's router
tests.

permission_scopes is authorization data, not a search input: SearchRequest
has no such field (extra="forbid" rejects it outright), and the router
resolves the caller's scopes itself via
modules.permissions.scope_resolver.resolve_permission_scopes(ctx), which
always returns [] today (see that module's docstring for why). Every
fixture decision below therefore uses permission_scope=[] (workspace-wide)
as the realistic default - a non-empty permission_scope is used only in
TestPermissionScopeFiltering, to prove such decisions are excluded no
matter what a client's request claims.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import app
from modules.answering.schemas import AnswerResult
from modules.auth.service import issue_tenant_jwt
from modules.retrieval.vector.schemas import RetrievalMatch

client = TestClient(app)

TENANT = uuid4()


def _match(**overrides) -> RetrievalMatch:
    fields = {
        "decision_id": uuid4(),
        "decision_statement": "We chose Stripe for PCI-compliant billing.",
        "similarity_score": 0.87,
        "confidence": 0.94,
        "tenant_id": TENANT,
        "permission_scope": [],
        "rationale": "Supports self-service billing.",
        "alternatives_considered": ["Paddle"],
        "created_at": datetime(2026, 7, 19, tzinfo=timezone.utc),
        "decision_type": "decision",
        "owner": "Jane Doe",
    }
    fields.update(overrides)
    return RetrievalMatch(**fields)


def _auth_headers(tenant_id=TENANT, role="member"):
    token = issue_tenant_jwt(user_id="user-123", tenant_id=str(tenant_id), role=role)
    return {"Authorization": f"Bearer {token}"}


def _request_body(**overrides):
    body = {"question": "Why did we choose Stripe?"}
    body.update(overrides)
    return body


@pytest.fixture(autouse=True)
def _default_resolved_scopes():
    """resolve_permission_scopes() is now async and hits a real DB lookup
    (the caller's own auth email) - default every test in this file to the
    old always-[] behavior unless a test explicitly patches it to something
    else (TestServerDerivedScopesAreUsed does, for exactly that reason)."""
    with patch(
        "modules.search.router.resolve_permission_scopes",
        AsyncMock(return_value=[]),
    ):
        yield


def _patched(matches, answer_result):
    mock_pool = MagicMock()
    return (
        patch("modules.search.router.get_db_pool", return_value=mock_pool),
        patch(
            "modules.search.service.vector_search", AsyncMock(return_value=(matches, 1024))
        ),
        patch("modules.search.service.generate_answer", AsyncMock(return_value=answer_result)),
    )


class TestSearchEndpointMountedExactlyOnce:
    def test_mounted_exactly_once_as_post(self):
        matches = [
            (route.path, method)
            for route in app.routes
            for method in getattr(route, "methods", set())
            if route.path == "/search"
        ]
        assert matches == [("/search", "POST")]


class TestAuthenticationRequired:
    def test_missing_jwt_is_rejected(self):
        response = client.post("/search", json=_request_body())
        assert response.status_code in (401, 403)

    def test_invalid_jwt_is_rejected(self):
        response = client.post(
            "/search", json=_request_body(), headers={"Authorization": "Bearer not-a-real-token"}
        )
        assert response.status_code == 401

    def test_client_supplied_tenant_id_in_body_is_rejected_as_unknown_field(self):
        """SearchRequest has extra="forbid" and no tenant_id field at all -
        a client cannot spoof tenant_id even by trying to add one."""
        pool_patch, vector_patch, answer_patch = _patched([], AnswerResult(
            answer="ok", citations=[], model="m", latency_ms=1.0
        ))
        with pool_patch, vector_patch, answer_patch:
            response = client.post(
                "/search",
                json={**_request_body(), "tenant_id": str(uuid4())},
                headers=_auth_headers(),
            )
        assert response.status_code == 422

    def test_client_supplied_permission_scopes_is_rejected_as_unknown_field(self):
        """permission_scopes is authorization data, not a search input:
        SearchRequest has no such field at all (extra="forbid" rejects any
        attempt to add one). A client cannot grant itself broader access by
        supplying scopes in the request body."""
        pool_patch, vector_patch, answer_patch = _patched([], AnswerResult(
            answer="ok", citations=[], model="m", latency_ms=1.0
        ))
        with pool_patch, vector_patch, answer_patch:
            response = client.post(
                "/search",
                json={**_request_body(), "permission_scopes": ["team:billing", "team:sales"]},
                headers=_auth_headers(),
            )
        assert response.status_code == 422

    def test_member_cannot_expand_access_via_request_supplied_scopes(self):
        """Even if a client sends permission_scopes claiming access to a
        scoped decision, the request is rejected outright (unknown field)
        and the decision remains excluded - proving request data can never
        expand what a member is authorized to see."""
        scoped = _match(permission_scope=["team:sales"])
        pool_patch, vector_patch, answer_patch = _patched([scoped], AnswerResult(
            answer="ok", citations=[], model="m", latency_ms=1.0
        ))
        with pool_patch, vector_patch, answer_patch:
            response = client.post(
                "/search",
                json={**_request_body(), "permission_scopes": ["team:sales"]},
                headers=_auth_headers(),
            )
        assert response.status_code == 422


class TestSuccessfulResponse:
    def test_returns_answer_citations_and_metadata(self):
        match = _match()
        answer_result = AnswerResult(
            answer="We chose Stripe for self-service billing (Decision 1).",
            citations=[1],
            model="claude-haiku-test",
            latency_ms=12.5,
        )
        pool_patch, vector_patch, answer_patch = _patched([match], answer_result)

        with pool_patch, vector_patch, answer_patch:
            response = client.post("/search", json=_request_body(), headers=_auth_headers())

        assert response.status_code == 200
        body = response.json()
        assert body["answer"] == "We chose Stripe for self-service billing (Decision 1)."
        assert body["metadata"]["retrieved_count"] == 1
        assert body["metadata"]["authorized_count"] == 1
        assert body["metadata"]["decision_count"] == 1
        assert len(body["citations"]) == 1
        assert body["citations"][0]["decision_id"] == str(match.decision_id)
        assert body["citations"][0]["decision_statement"] == match.decision_statement


class TestTenantIdDerivedFromAuth:
    def test_search_uses_authenticated_tenant_not_a_client_value(self):
        """Proof: the tenant the vector search actually runs against comes
        from the JWT, not from anything in the request body (which has no
        tenant_id field to begin with)."""
        answer_result = AnswerResult(answer="ok", citations=[], model="m", latency_ms=1.0)
        pool_patch, vector_patch, answer_patch = _patched([], answer_result)

        with pool_patch, vector_patch as vector_mock, answer_patch:
            client.post("/search", json=_request_body(), headers=_auth_headers(tenant_id=TENANT))

        (_pool, tenant_arg, _question, _top_k), _ = vector_mock.call_args
        # TenantContext.tenant_id is a str (a JWT claim) - compare accordingly.
        assert str(tenant_arg) == str(TENANT)


class TestServerDerivedScopesAreUsed:
    def test_router_calls_scope_resolver_with_authenticated_context_not_request_data(self):
        """Proof the scopes search() receives come from
        modules.permissions.scope_resolver.resolve_permission_scopes(ctx),
        never from request.permission_scopes (which doesn't exist)."""
        answer_result = AnswerResult(answer="ok", citations=[], model="m", latency_ms=1.0)
        pool_patch, vector_patch, answer_patch = _patched([], answer_result)

        with pool_patch, vector_patch, answer_patch, patch(
            "modules.search.router.resolve_permission_scopes", AsyncMock(return_value=["team:billing"])
        ) as resolver_mock:
            client.post("/search", json=_request_body(), headers=_auth_headers(role="member"))

        (ctx_arg,), _ = resolver_mock.call_args
        assert ctx_arg.tenant_id == str(TENANT)
        assert ctx_arg.role == "member"

    def test_resolved_scopes_flow_into_the_search_pipeline(self):
        """Whatever resolve_permission_scopes(ctx) returns is what actually
        gates a scoped decision - proven end-to-end through the real
        permission-filtering pipeline (not mocked)."""
        scoped = _match(permission_scope=["team:billing"])
        answer_result = AnswerResult(
            answer="Per Decision 1.", citations=[1], model="m", latency_ms=1.0
        )
        pool_patch, vector_patch, answer_patch = _patched([scoped], answer_result)

        with pool_patch, vector_patch, answer_patch, patch(
            "modules.search.router.resolve_permission_scopes", AsyncMock(return_value=["team:billing"])
        ):
            response = client.post("/search", json=_request_body(), headers=_auth_headers())

        assert response.json()["metadata"]["authorized_count"] == 1


class TestNoMatchingDecisions:
    def test_empty_retrieval_returns_refusal_and_zero_counts(self):
        answer_result = AnswerResult(
            answer="I couldn't find enough information in the available decisions.",
            citations=[],
            model="claude-haiku-test",
            latency_ms=1.0,
        )
        pool_patch, vector_patch, answer_patch = _patched([], answer_result)

        with pool_patch, vector_patch, answer_patch:
            response = client.post("/search", json=_request_body(), headers=_auth_headers())

        assert response.status_code == 200
        body = response.json()
        assert body["metadata"]["retrieved_count"] == 0
        assert body["citations"] == []


class TestPermissionScopeFiltering:
    def test_scoped_decisions_are_excluded_for_ordinary_members(self):
        """No repository evidence supports granting a member any non-empty
        scope, so resolve_permission_scopes(ctx) returns [] and a scoped
        decision is excluded - fail-closed, not a request-data decision."""
        match = _match(permission_scope=["team:sales"])
        answer_result = AnswerResult(answer="ok", citations=[], model="m", latency_ms=1.0)
        pool_patch, vector_patch, answer_patch = _patched([match], answer_result)

        with pool_patch, vector_patch, answer_patch:
            response = client.post("/search", json=_request_body(), headers=_auth_headers(role="member"))

        assert response.json()["metadata"]["authorized_count"] == 0

    def test_workspace_wide_decisions_are_included_for_ordinary_members(self):
        match = _match(permission_scope=[])
        answer_result = AnswerResult(
            answer="Per Decision 1.", citations=[1], model="m", latency_ms=1.0
        )
        pool_patch, vector_patch, answer_patch = _patched([match], answer_result)

        with pool_patch, vector_patch, answer_patch:
            response = client.post("/search", json=_request_body(), headers=_auth_headers(role="member"))

        assert response.json()["metadata"]["authorized_count"] == 1

    def test_owner_and_admin_get_no_special_cased_access_to_scoped_decisions(self):
        """Task 1's evidence: no code anywhere (decisions/router.py,
        decisions/service.py, or elsewhere) grants owner/admin roles
        broader visibility than ordinary members. Scoped decisions must be
        excluded for these roles too, exactly like a member."""
        scoped = _match(permission_scope=["team:sales"])
        answer_result = AnswerResult(answer="ok", citations=[], model="m", latency_ms=1.0)

        for role in ("owner", "admin"):
            pool_patch, vector_patch, answer_patch = _patched([scoped], answer_result)
            with pool_patch, vector_patch, answer_patch:
                response = client.post(
                    "/search", json=_request_body(), headers=_auth_headers(role=role)
                )
            assert response.json()["metadata"]["authorized_count"] == 0, f"role={role}"

    def test_scoped_decision_never_appears_in_citations(self):
        """A decision excluded by permission filtering must never surface
        as a citation, even if Claude's answer cites a position number that
        would have pointed at it had it not been filtered out."""
        scoped = _match(decision_statement="Scoped decision", permission_scope=["team:sales"])
        workspace_wide = _match(decision_statement="Workspace-wide decision", permission_scope=[])
        answer_result = AnswerResult(
            answer="Per Decision 1.", citations=[1], model="m", latency_ms=1.0
        )
        pool_patch, vector_patch, answer_patch = _patched([scoped, workspace_wide], answer_result)

        with pool_patch, vector_patch, answer_patch:
            response = client.post("/search", json=_request_body(), headers=_auth_headers())

        body = response.json()
        assert body["metadata"]["retrieved_count"] == 2
        assert body["metadata"]["authorized_count"] == 1
        citation_ids = {c["decision_id"] for c in body["citations"]}
        assert str(scoped.decision_id) not in citation_ids
        assert str(workspace_wide.decision_id) in citation_ids


class TestValidation:
    def test_blank_question_is_rejected(self):
        response = client.post(
            "/search", json=_request_body(question=""), headers=_auth_headers()
        )
        assert response.status_code == 422
