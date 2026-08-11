"""
Unit tests for Radar Corrections and Signal Logging.
"""
from __future__ import annotations

import json
import uuid
import pytest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import TenantContext
from database.pool import init_db_pool
from modules.decisions import service
from modules.decisions.router import router as decisions_router
from modules.decisions.schemas import RadarCorrectionFeedback
from modules.security.tenant_guard import TenantScopeError


class _FakeTransaction:
    """Minimal async-context-manager double for asyncpg's conn.transaction()."""

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


app = FastAPI()
app.include_router(decisions_router)
client = TestClient(app)


@pytest.mark.asyncio
async def test_list_decisions_hydrates_radar_fields():
    """Test list_decisions hydrates actors and source_links correctly."""
    tenant_id = uuid.uuid4()
    decision_id = uuid.uuid4()
    actor_id = uuid.uuid4()

    mock_dec_row = {
        "id": decision_id,
        "tenant_id": tenant_id,
        "record_type": "decision",
        "decision_statement": "Radar Statement",
        "rationale": "Radar Rationale",
        "alternatives_considered": ["Alt A"],
        "status": "proposed",
        "superseded_by": None,
        "scope": "team",
        "confidence": 0.85,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }

    mock_actor_row = {
        "tenant_id": tenant_id,
        "decision_id": decision_id,
        "actor_id": actor_id,
        "role": "decided_by",
        "display_name": "Radar Actor",
        "email": None,
        "notion_user_id": None,
        "slack_user_id": None,
    }

    mock_source_row = {
        "tenant_id": tenant_id,
        "decision_id": decision_id,
        "permalink": "https://locus.ai/decisions/1",
    }

    mock_conn = AsyncMock()
    mock_conn.execute = AsyncMock(return_value="SET")
    mock_conn.transaction = MagicMock(return_value=_FakeTransaction())

    async def mock_fetch(query, *args):
        if "decision_actors" in query:
            return [mock_actor_row]
        elif "decision_sources" in query:
            return [mock_source_row]
        return [mock_dec_row]

    mock_conn.fetch = mock_fetch
    mock_pool = MagicMock()
    mock_pool.acquire.return_value.__aenter__.return_value = mock_conn

    res = await service.list_decisions(
        tenant_id=tenant_id,
        pool=mock_pool,
        limit=10,
        offset=0,
    )

    assert res.total == 1
    item = res.items[0]
    assert item.id == decision_id
    assert item.source_links == ["https://locus.ai/decisions/1"]
    assert len(item.actors) == 1
    assert item.actors[0].id == str(actor_id)
    assert item.actors[0].role == "decided_by"
    assert item.actors[0].name == "Radar Actor"


@pytest.mark.asyncio
async def test_record_radar_correction_signal():
    """Test record_radar_correction writes a training signal record to DB."""
    tenant_id = uuid.uuid4()
    decision_id = uuid.uuid4()
    correction_id = uuid.uuid4()

    mock_row = {"id": correction_id}

    mock_conn = AsyncMock()
    mock_conn.execute = AsyncMock(return_value="SET")
    mock_conn.transaction = MagicMock(return_value=_FakeTransaction())
    mock_conn.fetchrow = AsyncMock(return_value=mock_row)

    mock_pool = MagicMock()
    mock_pool.acquire.return_value.__aenter__.return_value = mock_conn

    feedback = RadarCorrectionFeedback(
        decision_id=decision_id,
        action="edited",
        corrected_statement="New edited statement",
        note="User edit test note",
    )

    cid = await service.record_radar_correction(
        correction=feedback,
        original_statement="Original statement",
        original_status="proposed",
        tenant_id=tenant_id,
        pool=mock_pool,
    )

    assert cid == correction_id
    # Verify exact SQL parameters written
    mock_conn.fetchrow.assert_called_once()
    sql_args = mock_conn.fetchrow.call_args[0]
    assert sql_args[1] == tenant_id
    assert sql_args[2] == decision_id
    assert sql_args[3] == "edited"
    assert sql_args[4] == "Original statement"
    assert sql_args[5] == "New edited statement"
    assert sql_args[6] == "proposed"
    assert sql_args[7] == "User edit test note"


def test_router_correct_decision_confirmed_api():
    """POST /decisions/{id}/correct logs confirmation signal and updates status to decided."""
    tenant_id = uuid.uuid4()
    decision_id = uuid.uuid4()
    correction_id = uuid.uuid4()

    from modules.auth.service import issue_tenant_jwt
    token = issue_tenant_jwt(user_id="user-123", tenant_id=str(tenant_id), role="owner")

    mock_decision_out = MagicMock()
    mock_decision_out.decision_statement = "Target statement"
    mock_decision_out.status = "proposed"

    mock_db_pool = MagicMock()

    with patch("modules.decisions.router.get_db_pool", return_value=mock_db_pool), \
         patch("modules.decisions.service.get_decision", return_value=mock_decision_out), \
         patch("modules.decisions.service.patch_decision_status") as mock_patch, \
         patch("modules.decisions.service.record_radar_correction", return_value=correction_id) as mock_record:

        headers = {"Authorization": f"Bearer {token}"}
        payload = {
            "decision_id": str(decision_id),
            "action": "confirmed",
            "note": "Validated on radar feed",
        }

        response = client.post(
            f"/api/v1/decisions/{decision_id}/correct",
            json=payload,
            headers=headers,
        )

        assert response.status_code == 200
        res = response.json()
        assert res["status"] == "ok"
        assert res["correction_id"] == str(correction_id)

        # Assert status was patched to decided
        mock_patch.assert_called_once_with(
            decision_id=decision_id,
            new_status="decided",
            tenant_id=str(tenant_id),
            pool=mock_db_pool,
        )

        # Assert training signal recorded correctly
        mock_record.assert_called_once()
        recorded_corr = mock_record.call_args[1]["correction"]
        assert recorded_corr.action == "confirmed"
        assert recorded_corr.note == "Validated on radar feed"
