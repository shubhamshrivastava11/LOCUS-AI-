"""
Unit tests for modules.permissions.repository.is_decision_accessible().

Pure predicate, no mocking required: is the decision workspace-wide
(empty permission_scope), or does its permission_scope overlap the
caller's permission_scopes? Tenant boundaries are RLS's job
(modules.retrieval.vector.repository) and are not re-checked here - every
RetrievalMatch fixture below already shares one tenant_id.

The empty-decision-scope-is-accessible rule is repository evidence, not a
design choice made here - see modules.permissions.repository's module
docstring for the citations (EventEnvelope's field description, the Gmail
normalizer, and test_gmail.py's own assertion).
"""
from __future__ import annotations

from uuid import uuid4

from modules.permissions.repository import is_decision_accessible
from modules.retrieval.vector.schemas import RetrievalMatch

TENANT = uuid4()


def _decision(permission_scope: list[str] | None = None) -> RetrievalMatch:
    return RetrievalMatch(
        decision_id=uuid4(),
        decision_statement="We chose Stripe for PCI-compliant billing.",
        similarity_score=0.9,
        confidence=0.9,
        tenant_id=TENANT,
        permission_scope=permission_scope if permission_scope is not None else ["team:billing"],
    )


class TestMatchingPermissionScope:
    def test_exact_single_scope_match_is_accessible(self):
        decision = _decision(permission_scope=["team:engineering"])
        assert is_decision_accessible(["team:engineering"], decision) is True


class TestNonMatchingPermissionScope:
    def test_disjoint_scopes_are_rejected(self):
        decision = _decision(permission_scope=["team:sales"])
        assert is_decision_accessible(["team:engineering"], decision) is False


class TestMultiplePermissionScopes:
    def test_overlap_on_one_of_several_scopes_is_accessible(self):
        decision = _decision(permission_scope=["team:billing", "team:legal"])
        assert is_decision_accessible(["team:engineering", "team:billing"], decision) is True

    def test_no_overlap_across_several_scopes_is_rejected(self):
        decision = _decision(permission_scope=["team:sales", "team:marketing"])
        assert is_decision_accessible(["team:engineering", "team:billing"], decision) is False


class TestEmptyCallerScopes:
    def test_empty_caller_scopes_is_rejected_for_a_scoped_decision(self):
        """A non-empty decision.permission_scope always requires a proven
        overlap - a caller with no proven scopes can never satisfy that."""
        decision = _decision(permission_scope=["team:billing"])
        assert is_decision_accessible([], decision) is False


class TestWorkspaceWideDecisions:
    """An empty decision.permission_scope is workspace-wide (repository
    evidence: EventEnvelope's field description, the Gmail normalizer,
    test_gmail.py) - it is accessible to every tenant member regardless of
    their own permission_scopes, including a caller with none at all."""

    def test_empty_decision_scope_is_accessible_with_matching_caller_scopes(self):
        decision = _decision(permission_scope=[])
        assert is_decision_accessible(["team:billing"], decision) is True

    def test_empty_decision_scope_is_accessible_even_with_no_caller_scopes(self):
        decision = _decision(permission_scope=[])
        assert is_decision_accessible([], decision) is True


class TestUnmappedSlackNotionScopes:
    """Real Slack channel IDs / Notion page IDs have no ACL mapping
    anywhere yet (resolve_permission_scopes only ever returns the caller's
    own email) - a caller with no proven overlap still needs to see these,
    same as an empty scope, until real per-channel/page ACLs exist. See the
    module docstring for the live-confirmed bug this fixes."""

    def test_real_slack_channel_scope_is_accessible_without_overlap(self):
        decision = _decision(permission_scope=["C0BGH34EB0R"])
        assert is_decision_accessible([], decision) is True

    def test_real_notion_page_scope_is_accessible_without_overlap(self):
        decision = _decision(permission_scope=["c6ab72b6-f2f2-81e7-888d-0003a7b65b1e"])
        assert is_decision_accessible([], decision) is True

    def test_overlap_still_wins_when_caller_does_have_the_channel_scope(self):
        decision = _decision(permission_scope=["C0BGH34EB0R"])
        assert is_decision_accessible(["C0BGH34EB0R"], decision) is True


class TestScopesThatStillRequireOverlap:
    """Neither the eval corpus's synthetic privileged labels nor a Gmail
    own-email scope match the Slack/Notion ID shape, so they must keep
    failing closed without a proven overlap - the unmapped-scope fallback
    must not become a blanket bypass."""

    def test_synthetic_privileged_label_is_still_rejected_without_overlap(self):
        decision = _decision(permission_scope=["C_HR_CONFIDENTIAL"])
        assert is_decision_accessible([], decision) is False

    def test_gmail_email_scope_is_still_rejected_without_overlap(self):
        decision = _decision(permission_scope=["someone@example.com"])
        assert is_decision_accessible([], decision) is False

    def test_mixed_mapped_and_unmapped_scopes_still_require_overlap(self):
        """A decision scoped to both a real channel AND a privileged label
        must not become accessible just because one of its scopes is
        unmapped - all() requires every scope to be unmapped."""
        decision = _decision(permission_scope=["C0BGH34EB0R", "C_HR_CONFIDENTIAL"])
        assert is_decision_accessible([], decision) is False
