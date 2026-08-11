"""
Dedup ledger (Section 1.5) backed by public.raw_events (Section 1.6).

Key: UNIQUE (tenant_id, source, source_id) on public.raw_events.
is_duplicate / mark_seen are the only ingestion-layer idempotency API.
Persistence + encryption live in modules.ingestion.raw_events.store.
"""
from __future__ import annotations

import logging
import uuid

from database.pool import get_db_pool
from database.tenant_connection import tenant_conn
from modules.ingestion.raw_events.store import store_raw_event

log = logging.getLogger(__name__)


def _require_str(payload: dict, key: str) -> str:
    value = payload.get(key)
    if value is None or str(value).strip() == "":
        raise ValueError(f"envelope missing required field: {key}")
    return str(value)


def _parse_tenant_id(payload: dict) -> uuid.UUID:
    return uuid.UUID(_require_str(payload, "tenant_id"))


async def is_duplicate(payload: dict) -> bool:
    """Return True only if (tenant_id, source, source_id) exists in raw_events
    AND the AI pipeline actually reached a terminal outcome for it
    (pipeline_status = 'done') - not just that the row was inserted.

    mark_seen() runs before the AI pipeline, so a row can exist with the
    pipeline never having completed (a transient Claude/Voyage API error, a
    DB blip, a worker crash mid-message). Treating bare existence as "seen"
    made every retry after that a silent no-op forever - the pgmq message
    got skip-deleted without the pipeline ever running again, so content
    that should have become a decision never did, with nothing to flag it.
    A row still at 'pending' is treated as not-yet-seen so it gets a real
    retry on the next visibility-timeout cycle.
    """
    tenant_id = _parse_tenant_id(payload)
    source = _require_str(payload, "source")
    source_id = _require_str(payload, "source_id")

    pool = get_db_pool()
    async with tenant_conn(pool, tenant_id) as conn:
        exists = await conn.fetchval(
            """
            select exists(
              select 1
              from public.raw_events
              where tenant_id = $1
                and source = $2
                and source_id = $3
                and pipeline_status = 'done'
            )
            """,
            tenant_id,
            source,
            source_id,
        )
    return bool(exists)


async def mark_processed(tenant_id: uuid.UUID | str, raw_event_id: uuid.UUID) -> None:
    """Mark a raw_events row's AI pipeline as having reached a terminal
    outcome (DISCARD, or a persisted decision) - the row is now safe to
    treat as truly deduplicated. Not called if the pipeline raises, so a
    crashed/interrupted attempt stays retryable.
    """
    pool = get_db_pool()
    async with tenant_conn(pool, tenant_id) as conn:
        await conn.execute(
            "update public.raw_events set pipeline_status = 'done' where id = $1",
            raw_event_id,
        )


async def mark_seen(payload: dict) -> uuid.UUID | None:
    """
    Record the event in the ledger / raw store (encrypted).

    Returns raw_events.id, or None if already present (unique conflict).
    """
    raw_event_id = await store_raw_event(payload)
    if raw_event_id is None:
        log.info(
            "mark_seen conflict (already present): source=%s source_id=%s",
            payload.get("source"),
            payload.get("source_id"),
        )
        return None

    log.info(
        "mark_seen stored raw_event_id=%s source=%s source_id=%s",
        raw_event_id,
        payload.get("source"),
        payload.get("source_id"),
    )
    return raw_event_id
