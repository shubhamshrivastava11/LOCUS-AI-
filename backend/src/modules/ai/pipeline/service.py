"""
Ingestion processing service — triage/extraction, then persistence, then
embedding enqueue, for one already-validated EventEnvelope.

process_and_persist_event() composes the standalone AI pipeline
(process_ai_event()) with atomic decision persistence
(persist_decision_from_extraction()) and the embedding queue producer
(enqueue_embedding_job()): triage always runs; DISCARD stops there and
persists nothing and enqueues nothing; KEEP and UNCERTAIN both get
extracted and persisted as-is for the current MVP — UNCERTAIN is never
silently upgraded to KEEP or downgraded to DISCARD, and the returned triage
always reflects whatever process_ai_event() actually decided. Once
persist_decision_from_extraction() commits, an embedding job carrying only
tenant_id and decision_id is enqueued; the embedding worker fetches the
persisted decision itself.

tenant_id is taken from event.tenant_id throughout - the same value the
connector already validated and wrote into raw_events, not a second
parameter that could disagree with it.
"""
from __future__ import annotations

import logging
from uuid import UUID

import asyncpg

from modules.ai.pipeline.orchestrator import AIPipelineError, process_ai_event
from modules.ai.pipeline.schemas import IngestionProcessingResult
from modules.ai.triage.schemas import TriageDecision
from modules.decisions.pipeline_persistence import (
    PipelinePersistenceError,
    persist_decision_from_extraction,
)
from modules.ingestion.dedup.ledger import mark_processed
from modules.ingestion.envelope.schemas import EventEnvelope
from queues.pgmq.producer import EmbeddingEnqueueError, enqueue_embedding_job

log = logging.getLogger(__name__)


class IngestionServiceError(Exception):
    """Base class for all process_and_persist_event() failures."""


class IngestionPipelineError(IngestionServiceError):
    """The AI pipeline (process_ai_event(): triage/extraction) failed."""


class IngestionPersistenceError(IngestionServiceError):
    """Persistence (persist_decision_from_extraction()) failed after the AI pipeline succeeded."""


class IngestionEmbeddingEnqueueError(IngestionServiceError):
    """Embedding enqueue failed after the decision was already persisted.

    The persistence transaction has already committed by the time this is
    raised — the decision is not rolled back. Retrying the enqueue here is
    deliberately out of scope; reconciliation for decisions stuck without an
    embedding job is left to a future worker or repair job.
    """


async def process_and_persist_event(
    pool: asyncpg.Pool,
    event: EventEnvelope,
    origin_raw_event_id: UUID,
    source_permalink: str | None = None,
    scope: str = "team",
    scope_actor_id: UUID | None = None,
) -> IngestionProcessingResult:
    """Run triage/extraction, then persist and enqueue embedding unless
    triage discarded the event.

    Raises IngestionPipelineError if process_ai_event() fails,
    IngestionPersistenceError if persist_decision_from_extraction() fails, or
    IngestionEmbeddingEnqueueError if enqueue_embedding_job() fails after a
    successful persist — callers can catch IngestionServiceError to handle
    any of these uniformly, or catch the subclasses separately. The embedding
    job is never enqueued before persistence commits, and a failed enqueue
    never triggers a rollback of the already-persisted decision.
    """
    try:
        ai_result = await process_ai_event(event)
    except AIPipelineError as exc:
        raise IngestionPipelineError(f"AI pipeline failed: {exc}") from exc

    if ai_result.triage.decision == TriageDecision.DISCARD:
        log.debug("Triage DISCARD - persistence skipped")
        await mark_processed(event.tenant_id, origin_raw_event_id)
        return IngestionProcessingResult(
            triage=ai_result.triage,
            extraction=None,
            decision_id=None,
            persisted=False,
            embedding_enqueued=False,
        )

    assert ai_result.extraction is not None  # guaranteed by AIProcessingResult's own invariant

    try:
        decision_id = await persist_decision_from_extraction(
            pool,
            event.tenant_id,
            event,
            ai_result.extraction,
            origin_raw_event_id,
            source_permalink=source_permalink,
            scope=scope,
            scope_actor_id=scope_actor_id,
        )
    except PipelinePersistenceError as exc:
        raise IngestionPersistenceError(f"Failed to persist decision: {exc}") from exc

    # Marked done as soon as the decision itself is safely persisted, before
    # attempting the embedding enqueue - a failed enqueue from here on is a
    # separate, already-documented gap (see IngestionEmbeddingEnqueueError),
    # not a reason to let a retry re-run triage/extraction and risk a second
    # decision for the same raw event.
    await mark_processed(event.tenant_id, origin_raw_event_id)

    log.info("Persisted decision id=%s triage=%s", decision_id, ai_result.triage.decision.value)

    try:
        await enqueue_embedding_job(tenant_id=event.tenant_id, decision_id=decision_id)
    except EmbeddingEnqueueError as exc:
        raise IngestionEmbeddingEnqueueError(
            f"Decision {decision_id} was persisted but embedding enqueue failed: {exc}"
        ) from exc

    return IngestionProcessingResult(
        triage=ai_result.triage,
        extraction=ai_result.extraction,
        decision_id=decision_id,
        persisted=True,
        embedding_enqueued=True,
    )
