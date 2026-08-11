"""
Embedding worker - polls the embedding queue and embeds each decision.

Mirrors queues.workers.event_worker's read -> process -> delete loop: a
message is only deleted after process_embedding_job() persists the
embedding. Any failure (invalid payload, missing decision, Voyage API
error, DB error) leaves the message in place so pgmq's visibility timeout
makes it eligible for another read and retry.

Retry limitation: PgmqClient currently exposes only send/read/delete - there
is no archive() or dead-letter queue. A message that keeps failing (e.g. its
decision_id was deleted after the job was enqueued, so DecisionNotFoundError
is permanent) retries forever with no cap, since inventing archive/DLQ
infrastructure is out of scope here. read_ct is logged on every failure so a
future PgmqClient.archive()-based repair job has what it needs to add a cap;
none is enforced by this worker.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from pydantic import ValidationError

from database.pool import get_db_pool
from modules.ai.embeddings.service import DecisionNotFoundError, process_embedding_job
from queues.pgmq.client import PgmqClient, get_pgmq_client
from queues.pgmq.queues import QueueName
from queues.pgmq.schemas import EmbeddingJob

log = logging.getLogger(__name__)

VISIBILITY_TIMEOUT_SECONDS = 60
POLL_INTERVAL_SECONDS = 2
BATCH_SIZE = 20

# Failures that will never succeed on retry. Still left in the queue (no
# delete-on-failure path exists), but logged distinctly from a transient
# failure so operators/log queries can tell the two apart.
_NON_RETRYABLE_EXCEPTIONS = (ValidationError, DecisionNotFoundError)


async def run_embedding_worker() -> None:
    """Long-running worker loop: read -> process -> delete from the embedding queue."""
    client = get_pgmq_client()
    pool = get_db_pool()
    log.info("Embedding worker started - polling %s", QueueName.EMBEDDING)

    while True:
        messages = await client.read(
            QueueName.EMBEDDING, vt=VISIBILITY_TIMEOUT_SECONDS, batch=BATCH_SIZE
        )
        if messages:
            await asyncio.gather(*(_handle_message(client, pool, msg) for msg in messages))
        else:
            await asyncio.sleep(POLL_INTERVAL_SECONDS)


async def _handle_message(client: PgmqClient, pool: Any, msg: dict) -> None:
    """Validate, process, and (only on success) delete one pgmq message.

    Logs only safe metadata (msg_id, tenant_id, decision_id, error type) —
    never the searchable text, raw content, embedding vector, API key, or
    database URL.
    """
    msg_id = msg["msg_id"]
    read_ct = msg.get("read_ct")

    try:
        job = EmbeddingJob.model_validate(_normalize_payload(msg["message"]))
    except ValidationError as exc:
        log.error(
            "Invalid EmbeddingJob payload msg_id=%s read_ct=%s error_type=%s "
            "- non-retryable, message left in queue",
            msg_id, read_ct, type(exc).__name__,
        )
        return

    try:
        await process_embedding_job(pool, job)
    except _NON_RETRYABLE_EXCEPTIONS as exc:
        log.error(
            "Non-retryable embedding failure msg_id=%s tenant_id=%s decision_id=%s "
            "read_ct=%s error_type=%s",
            msg_id, job.tenant_id, job.decision_id, read_ct, type(exc).__name__,
        )
        return
    except Exception as exc:
        log.warning(
            "Retryable embedding failure msg_id=%s tenant_id=%s decision_id=%s "
            "read_ct=%s error_type=%s - will retry after VT expires",
            msg_id, job.tenant_id, job.decision_id, read_ct, type(exc).__name__,
        )
        return

    await client.delete(QueueName.EMBEDDING, msg_id)
    log.info(
        "Embedded and deleted msg_id=%s tenant_id=%s decision_id=%s",
        msg_id, job.tenant_id, job.decision_id,
    )


def _normalize_payload(raw: Any) -> dict:
    """pgmq may return message as dict or JSON string depending on driver/version."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        return json.loads(raw)
    if isinstance(raw, (bytes, bytearray)):
        return json.loads(raw.decode("utf-8"))
    raise TypeError(f"Unexpected message type: {type(raw)!r}")
