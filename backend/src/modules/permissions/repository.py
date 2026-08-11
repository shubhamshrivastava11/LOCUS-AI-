"""
Permission Repository — the authorization predicate over one retrieved
decision: workspace-wide visibility, or overlapping permission_scope for
the authenticated caller.

Pure, DB-free rule evaluation. Tenant boundaries are already enforced by
RLS inside modules.retrieval.vector.repository (Layer 1) before any row
ever reaches this module - this is the second, independent authorization
axis RLS does not cover (which sub-tenant scopes, e.g. Slack channels, a
specific caller may see), not a re-check of tenant_id.

Repository evidence for the empty-scope rule (modules.ingestion.envelope.
schemas.EventEnvelope.permission_scope's field description, confirmed by
modules.ingestion.envelope.normalizer.normalize_gmail_message and by
tests/unit/test_gmail.py's own assertion) is unambiguous: an empty
permission_scope means "workspace-wide" - visible to every tenant member -
not "inaccessible". Every decision ingested by the only pipeline that
exists today (Gmail) has permission_scope == [] for exactly this reason.

Slack (slack-webhook) and Notion (notion-poller) instead scope a decision
to the real channel/page it came from (e.g. "C0BGH34EB0R"), and nothing
anywhere resolves which channels/pages a given caller actually belongs to
- modules.permissions.scope_resolver.resolve_permission_scopes() only ever
returns the caller's own email address. The result: every Slack/Notion
decision with a real channel/page scope was unconditionally rejected here,
for every caller, forever - confirmed live (a real "build failed" decision
scoped to a real Slack channel was retrieved correctly but then dropped by
this filter for the one user who is actually in that channel). Until real
per-channel/page ACLs exist, _is_unmapped_scope() treats those real,
connector-assigned identifiers as "no enforceable ACL yet" and falls back
to the same workspace-wide visibility empty scope already gets - not
because we know the caller can see it, but because keeping it invisible to
everyone, including the person who actually sent the message, is strictly
worse. This does NOT extend to the synthetic C_HR_CONFIDENTIAL/
C_LEGAL_PRIVILEGED/C_SECURITY_INTERNAL/C_FINANCE_PRIVATE scopes the eval
corpus (backend/scripts/generate_eval_corpus_v2.py) uses to test that
privileged content stays filtered, nor to Gmail's own-email scopes - both
keep strict overlap enforcement.
"""
from __future__ import annotations

import re

from modules.retrieval.vector.schemas import RetrievalMatch

# Real Slack channel IDs: "C" followed by 8+ base-32-ish characters
# (Slack's own format, e.g. "C0BGH34EB0R").
_SLACK_CHANNEL_RE = re.compile(r"^C[A-Z0-9]{8,}$")

# Real Notion page/database IDs are UUIDs.
_NOTION_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


def _is_unmapped_scope(scope: str) -> bool:
    """True for a real Slack channel ID or Notion page/database ID - an
    identifier a connector assigned, that no ACL table anywhere maps back to
    a set of members. See module docstring.
    """
    return bool(_SLACK_CHANNEL_RE.match(scope) or _NOTION_ID_RE.match(scope))


def is_decision_accessible(permission_scopes: list[str], decision: RetrievalMatch) -> bool:
    """True iff the decision is workspace-wide, its permission_scope
    overlaps the caller's permission_scopes, or every scope on the decision
    is an unmapped Slack/Notion identifier we have no ACL for yet.

    An empty decision.permission_scope is workspace-wide and is always
    accessible, regardless of the caller's scopes (see module docstring
    for the repository evidence). A non-empty decision.permission_scope
    first tries an actual overlap with the caller's permission_scopes; if
    that fails, it's still accessible when every one of its scopes is an
    unmapped channel/page identifier (see _is_unmapped_scope) - real ACL'd
    scopes (Gmail email addresses, the eval corpus's synthetic privileged
    labels) still require a real overlap and are rejected without one.
    """
    if not decision.permission_scope:
        return True
    if set(decision.permission_scope) & set(permission_scopes):
        return True
    return all(_is_unmapped_scope(scope) for scope in decision.permission_scope)
