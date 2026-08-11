"""
Ingestion event worker - polls the ingestion queue and dispatches each event.

Flow: pgmq message -> EventEnvelope validation -> dedup/raw event persistence
-> process_and_persist_event() (triage -> extraction -> persist -> enqueue
embedding job) -> delete the pgmq message.

Mirrors queues.workers.embedding_worker's read -> process -> delete contract:
a message is only deleted after the full chain succeeds, or after a known
duplicate is skipped. Any other failure - a malformed payload, an
EventEnvelope validation error, a dedup/raw-event-storage error, or an AI
pipeline/persistence error - leaves the message in place so pgmq's
visibility timeout makes it eligible for another read and retry.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from pydantic import ValidationError

from database.pool import get_db_pool
from modules.ai.pipeline.service import process_and_persist_event
from modules.ingestion.dedup.ledger import is_duplicate, mark_seen
from modules.ingestion.envelope.schemas import EventEnvelope
from queues.pgmq.client import PgmqClient, get_pgmq_client
from queues.pgmq.queues import QueueName

log = logging.getLogger(__name__)

VISIBILITY_TIMEOUT_SECONDS = 60
POLL_INTERVAL_SECONDS = 2
BATCH_SIZE = 20


async def run_event_worker() -> None:
    """Long-running worker loop: read -> process -> delete from the ingestion queue.

    Messages in a batch are handled concurrently (asyncio.gather), not one
    at a time - each _handle_message() call is DB/AI-pipeline-bound, so
    processing them sequentially left the DB pool (max_size configured well
    above 1) and Claude/Voyage clients almost entirely idle between round
    trips. Concurrency is naturally capped by the pool's max_size: extra
    acquire() calls beyond that just queue, they don't error.
    """
    client = get_pgmq_client()
    pool = get_db_pool()
    log.info("Event worker started - polling %s", QueueName.INGESTION)

    while True:
        messages = await client.read(
            QueueName.INGESTION, vt=VISIBILITY_TIMEOUT_SECONDS, batch=BATCH_SIZE
        )
        if messages:
            await asyncio.gather(*(_handle_message(client, pool, msg) for msg in messages))
        else:
            await asyncio.sleep(POLL_INTERVAL_SECONDS)


def _normalize_payload(raw: Any) -> dict:
    """pgmq may return message as dict or JSON string depending on driver/version."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        return json.loads(raw)
    if isinstance(raw, (bytes, bytearray)):
        return json.loads(raw.decode("utf-8"))
    raise TypeError(f"Unexpected message type: {type(raw)!r}")


async def _handle_message(client: PgmqClient, pool: Any, msg: dict) -> None:
    """Validate, process, and (only on success or known duplicate) delete one message.

    Steps, matching the module docstring's flow: normalize the raw pgmq
    payload, validate it as an EventEnvelope, run the existing dedup/raw
    event persistence (unchanged, still keyed off the raw payload dict - not
    the validated model, since store_raw_event() also reads connector-only
    fields like external_workspace_id that EventEnvelope doesn't carry),
    then run process_and_persist_event() and delete the message only if it
    returns successfully. A duplicate (either found up front or lost the
    insert race) is treated as already-processed and deleted without ever
    reaching the AI pipeline.

    Logs only safe metadata (msg_id, tenant_id, source, source_id,
    raw_event_id, decision_id) - never raw_content, API keys, database URL,
    or embedding vectors.
    """
    msg_id = msg["msg_id"]

    try:
        payload = _normalize_payload(msg["message"])
    except (TypeError, ValueError) as exc:
        log.error(
            "Malformed pgmq message payload msg_id=%s error_type=%s "
            "- non-retryable, message left in queue",
            msg_id, type(exc).__name__,
        )
        return

    try:
        event = EventEnvelope.model_validate(payload)
    except ValidationError as exc:
        log.error(
            "Invalid EventEnvelope payload msg_id=%s tenant_id=%s source=%s error_type=%s "
            "- non-retryable, message left in queue",
            msg_id, payload.get("tenant_id"), payload.get("source"), type(exc).__name__,
        )
        return

    try:
        if await is_duplicate(payload):
            log.info(
                "Duplicate skipped msg_id=%s tenant_id=%s source=%s source_id=%s",
                msg_id, event.tenant_id, event.source, event.source_id,
            )
            await client.delete(QueueName.INGESTION, msg_id)
            return

        raw_event_id = await mark_seen(payload)
        if raw_event_id is None:
            log.info(
                "Duplicate on insert (race) msg_id=%s tenant_id=%s source=%s source_id=%s",
                msg_id, event.tenant_id, event.source, event.source_id,
            )
            await client.delete(QueueName.INGESTION, msg_id)
            return
    except Exception as exc:
        log.error(
            "Dedup/raw-event persistence failed msg_id=%s tenant_id=%s source=%s source_id=%s "
            "error_type=%s - will retry after VT expires",
            msg_id, event.tenant_id, event.source, event.source_id, type(exc).__name__,
        )
        return

    log.info(
        "Accepted new event msg_id=%s tenant_id=%s raw_event_id=%s source=%s source_id=%s",
        msg_id, event.tenant_id, raw_event_id, event.source, event.source_id,
    )

    try:
        result = await process_and_persist_event(
            pool,
            event,
            origin_raw_event_id=raw_event_id,
            source_permalink=payload.get("source_permalink"),
        )
    except Exception as exc:
        log.error(
            "AI pipeline/persistence failed msg_id=%s tenant_id=%s raw_event_id=%s "
            "error_type=%s - will retry after VT expires",
            msg_id, event.tenant_id, raw_event_id, type(exc).__name__,
        )
        return

    await client.delete(QueueName.INGESTION, msg_id)
    log.info(
        "Processed and deleted msg_id=%s tenant_id=%s raw_event_id=%s decision_id=%s "
        "triage=%s persisted=%s",
        msg_id, event.tenant_id, raw_event_id, result.decision_id,
        result.triage.decision.value, result.persisted,
    )
