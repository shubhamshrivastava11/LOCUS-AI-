"""
Unit tests for modules.ai.pipeline.service.process_and_persist_event().

process_ai_event(), persist_decision_from_extraction(), and
enqueue_embedding_job() are all mocked at their service.py import sites -
this tests only the sequencing and error-wrapping, not any of those
functions' own internals (each has its own dedicated test file).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest

from modules.ai.extraction.schemas import DecisionStatus, ExtractionResult, RecordType
from modules.ai.pipeline.orchestrator import AIPipelineError
from modules.ai.pipeline.schemas import AIProcessingResult
from modules.ai.pipeline.service import (
    IngestionEmbeddingEnqueueError,
    IngestionPersistenceError,
    IngestionPipelineError,
    process_and_persist_event,
)
from modules.ai.triage.schemas import TriageDecision, TriageReasonCode, TriageResult
from modules.decisions.pipeline_persistence import DecisionPersistenceError
from modules.ingestion.envelope.schemas import EventEnvelope
from queues.pgmq.producer import EmbeddingEnqueueError

pytestmark = pytest.mark.asyncio

TENANT = uuid.uuid4()
RAW_EVENT_ID = uuid.uuid4()
DECISION_ID = uuid.uuid4()


def _event() -> EventEnvelope:
    return EventEnvelope(
        tenant_id=TENANT,
        source="gmail",
        source_id="18d1234abcd",
        actor="alice@example.com",
        permission_scope=[],
        raw_content={"subject": "Re: pricing", "body": "We decided to ship Friday."},
    )


def _triage(decision: TriageDecision) -> TriageResult:
    return TriageResult(decision=decision, confidence=0.9, reason_code=TriageReasonCode.EXPLICIT_DECISION)


def _extraction() -> ExtractionResult:
    return ExtractionResult(
        record_type=RecordType.DECISION,
        status=DecisionStatus.DECIDED,
        decision_statement="Ship Friday.",
        confidence=0.9,
    )


class TestDiscardSkipsPersistenceAndEnqueue:
    async def test_discard_returns_unpersisted_result_without_touching_db_or_queue(self):
        with (
            patch(
                "modules.ai.pipeline.service.process_ai_event",
                AsyncMock(return_value=AIProcessingResult(triage=_triage(TriageDecision.DISCARD))),
            ),
            patch("modules.ai.pipeline.service.persist_decision_from_extraction", AsyncMock()) as persist_mock,
            patch("modules.ai.pipeline.service.enqueue_embedding_job", AsyncMock()) as enqueue_mock,
            patch("modules.ai.pipeline.service.mark_processed", AsyncMock()) as mark_processed_mock,
        ):
            result = await process_and_persist_event(object(), _event(), RAW_EVENT_ID)

        assert result.persisted is False
        assert result.embedding_enqueued is False
        assert result.decision_id is None
        persist_mock.assert_not_awaited()
        enqueue_mock.assert_not_awaited()
        mark_processed_mock.assert_awaited_once_with(TENANT, RAW_EVENT_ID)


class TestKeepPersistsAndEnqueues:
    async def test_keep_persists_and_enqueues_embedding(self):
        with (
            patch(
                "modules.ai.pipeline.service.process_ai_event",
                AsyncMock(
                    return_value=AIProcessingResult(
                        triage=_triage(TriageDecision.KEEP), extraction=_extraction()
                    )
                ),
            ),
            patch(
                "modules.ai.pipeline.service.persist_decision_from_extraction",
                AsyncMock(return_value=DECISION_ID),
            ) as persist_mock,
            patch(
                "modules.ai.pipeline.service.enqueue_embedding_job", AsyncMock(return_value=1)
            ) as enqueue_mock,
            patch("modules.ai.pipeline.service.mark_processed", AsyncMock()) as mark_processed_mock,
        ):
            result = await process_and_persist_event(object(), _event(), RAW_EVENT_ID)

        assert result.persisted is True
        assert result.embedding_enqueued is True
        assert result.decision_id == DECISION_ID
        persist_mock.assert_awaited_once()
        enqueue_mock.assert_awaited_once_with(tenant_id=TENANT, decision_id=DECISION_ID)
        mark_processed_mock.assert_awaited_once_with(TENANT, RAW_EVENT_ID)

    async def test_embedding_job_is_enqueued_only_after_persistence_commits(self):
        """Ordering proof: enqueue must never be called before persist
        returns - a failed persist must never leave an orphaned embedding
        job pointing at a decision that doesn't exist."""
        call_order = []

        async def fake_persist(*args, **kwargs):
            call_order.append("persist")
            return DECISION_ID

        async def fake_mark_processed(*args, **kwargs):
            call_order.append("mark_processed")

        async def fake_enqueue(*args, **kwargs):
            call_order.append("enqueue")
            return 1

        with (
            patch(
                "modules.ai.pipeline.service.process_ai_event",
                AsyncMock(
                    return_value=AIProcessingResult(
                        triage=_triage(TriageDecision.KEEP), extraction=_extraction()
                    )
                ),
            ),
            patch("modules.ai.pipeline.service.persist_decision_from_extraction", fake_persist),
            patch("modules.ai.pipeline.service.mark_processed", fake_mark_processed),
            patch("modules.ai.pipeline.service.enqueue_embedding_job", fake_enqueue),
        ):
            await process_and_persist_event(object(), _event(), RAW_EVENT_ID)

        assert call_order == ["persist", "mark_processed", "enqueue"]


class TestUncertainAlsoPersists:
    async def test_uncertain_triage_persists_like_keep(self):
        with (
            patch(
                "modules.ai.pipeline.service.process_ai_event",
                AsyncMock(
                    return_value=AIProcessingResult(
                        triage=_triage(TriageDecision.UNCERTAIN), extraction=_extraction()
                    )
                ),
            ),
            patch(
                "modules.ai.pipeline.service.persist_decision_from_extraction",
                AsyncMock(return_value=DECISION_ID),
            ),
            patch("modules.ai.pipeline.service.enqueue_embedding_job", AsyncMock(return_value=1)),
            patch("modules.ai.pipeline.service.mark_processed", AsyncMock()),
        ):
            result = await process_and_persist_event(object(), _event(), RAW_EVENT_ID)

        assert result.persisted is True
        assert result.triage.decision == TriageDecision.UNCERTAIN


class TestFailureWrapping:
    async def test_ai_pipeline_failure_is_wrapped(self):
        with patch(
            "modules.ai.pipeline.service.process_ai_event",
            AsyncMock(side_effect=AIPipelineError("boom")),
        ):
            with pytest.raises(IngestionPipelineError):
                await process_and_persist_event(object(), _event(), RAW_EVENT_ID)

    async def test_persistence_failure_is_wrapped(self):
        with (
            patch(
                "modules.ai.pipeline.service.process_ai_event",
                AsyncMock(
                    return_value=AIProcessingResult(
                        triage=_triage(TriageDecision.KEEP), extraction=_extraction()
                    )
                ),
            ),
            patch(
                "modules.ai.pipeline.service.persist_decision_from_extraction",
                AsyncMock(side_effect=DecisionPersistenceError("db down")),
            ),
        ):
            with pytest.raises(IngestionPersistenceError):
                await process_and_persist_event(object(), _event(), RAW_EVENT_ID)

    async def test_embedding_enqueue_failure_after_persist_is_wrapped_not_rolled_back(self):
        """The decision is already committed by the time enqueue fails -
        this must surface as its own distinct error, not silently swallow
        the fact that persistence already succeeded."""
        with (
            patch(
                "modules.ai.pipeline.service.process_ai_event",
                AsyncMock(
                    return_value=AIProcessingResult(
                        triage=_triage(TriageDecision.KEEP), extraction=_extraction()
                    )
                ),
            ),
            patch(
                "modules.ai.pipeline.service.persist_decision_from_extraction",
                AsyncMock(return_value=DECISION_ID),
            ),
            patch(
                "modules.ai.pipeline.service.enqueue_embedding_job",
                AsyncMock(side_effect=EmbeddingEnqueueError("queue down")),
            ),
            patch("modules.ai.pipeline.service.mark_processed", AsyncMock()) as mark_processed_mock,
        ):
            with pytest.raises(IngestionEmbeddingEnqueueError):
                await process_and_persist_event(object(), _event(), RAW_EVENT_ID)

        mark_processed_mock.assert_awaited_once_with(TENANT, RAW_EVENT_ID)
