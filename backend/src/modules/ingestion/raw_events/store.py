"""
Raw event store (Section 1.6) — encrypted write with 30-day TTL + purge.

Dedup is enforced here via `on conflict (tenant_id, source, source_id) do
nothing` — store_raw_event returns None on a duplicate, which is exactly
what modules.ingestion.dedup.ledger.mark_seen() expects.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from database.pool import get_db_pool
from database.tenant_connection import tenant_conn
from modules.security.encryption import decrypt_raw_content, encrypt_raw_content

log = logging.getLogger(__name__)


def _require_str(payload: dict, key: str) -> str:
    value = payload.get(key)
    if value is None or str(value).strip() == "":
        raise ValueError(f"envelope missing required field: {key}")
    return str(value)


async def _resolve_connection_id(
    conn: Any,
    tenant_id: uuid.UUID,
    source: str,
    payload: dict,
) -> uuid.UUID:
    """Look up the source_connections row for this event, if not already known."""
    external_id = payload.get("external_workspace_id") or payload.get("team_id")

    if external_id:
        row = await conn.fetchrow(
            """
            select id
            from public.source_connections
            where tenant_id = $1
              and source = $2
              and external_workspace_id = $3
            limit 1
            """,
            tenant_id,
            source,
            str(external_id),
        )
        if row:
            return row["id"]

    row = await conn.fetchrow(
        """
        select id
        from public.source_connections
        where tenant_id = $1
          and source = $2
          and status = 'active'
        order by created_at asc
        limit 1
        """,
        tenant_id,
        source,
    )
    if not row:
        raise RuntimeError(
            f"No source_connections row for tenant_id={tenant_id} source={source}. "
            "Insert a connection before processing events."
        )
    return row["id"]


async def store_raw_event(
    envelope: dict, connection_id: uuid.UUID | None = None
) -> uuid.UUID | None:
    """
    Encrypt and persist a raw event. Returns the stored record ID,
    or None if (tenant_id, source, source_id) already exists.

    connection_id: pass this directly if the caller already knows it
    (e.g. Gmail's service.py, which resolves it during OAuth callback).
    If omitted, it's looked up automatically from source_connections.
    """
    tenant_id = uuid.UUID(_require_str(envelope, "tenant_id"))
    source = _require_str(envelope, "source")
    source_id = _require_str(envelope, "source_id")
    thread_ref = envelope.get("thread_ref") or envelope.get("thread_ts")
    plaintext = json.dumps(envelope, default=str).encode("utf-8")
    raw_bytes = encrypt_raw_content(plaintext)

    pool = get_db_pool()
    async with tenant_conn(pool, tenant_id) as conn:
        if connection_id is None:
            connection_id = await _resolve_connection_id(conn, tenant_id, source, envelope)

        row = await conn.fetchrow(
            """
            insert into public.raw_events (
              tenant_id,
              connection_id,
              source,
              source_id,
              thread_ref,
              permission_scope,
              raw_content,
              metadata,
              triage_result
            ) values (
              $1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending'
            )
            on conflict (tenant_id, source, source_id) do nothing
            returning id
            """,
            tenant_id,
            connection_id,
            source,
            source_id,
            str(thread_ref) if thread_ref is not None else None,
            list(envelope.get("permission_scope") or []),
            raw_bytes,
            json.dumps(
                {
                    "ingested_via": "worker",
                    "event_type": envelope.get("event_type"),
                    "encrypted": True,
                }
            ),
        )

    if row is None:
        # ON CONFLICT DO NOTHING fires whenever a row already exists for this
        # key, regardless of whether that row's pipeline ever finished. A row
        # stuck at pipeline_status='pending' (crashed/interrupted first
        # attempt) must NOT be treated the same as a truly-completed
        # duplicate - doing so is exactly what was silently discarding every
        # retry system-wide (see modules.ingestion.dedup.ledger.is_duplicate's
        # docstring for the first half of this bug). Look up the existing
        # row and only report "no id" for a row that's actually done;
        # otherwise hand back its id so the caller retries the pipeline
        # against it instead of losing the message.
        async with tenant_conn(get_db_pool(), tenant_id) as lookup_conn:
            existing = await lookup_conn.fetchrow(
                """
                select id, pipeline_status
                from public.raw_events
                where tenant_id = $1 and source = $2 and source_id = $3
                """,
                tenant_id,
                source,
                source_id,
            )

        if existing is not None and existing["pipeline_status"] == "pending":
            log.info(
                "store_raw_event conflict but pipeline never completed - "
                "returning existing id for retry: source=%s source_id=%s raw_event_id=%s",
                source,
                source_id,
                existing["id"],
            )
            return existing["id"]

        log.info(
            "store_raw_event conflict (already present, done): source=%s source_id=%s",
            source,
            source_id,
        )
        return None

    log.info(
        "store_raw_event id=%s tenant=%s source=%s source_id=%s",
        row["id"],
        tenant_id,
        source,
        source_id,
    )
    return row["id"]


async def load_raw_event_payload(
    raw_event_id: uuid.UUID, tenant_id: uuid.UUID
) -> dict:
    """Load and decrypt a raw event payload by id (for replay)."""
    pool = get_db_pool()
    async with tenant_conn(pool, tenant_id) as conn:
        row = await conn.fetchrow(
            "select raw_content from public.raw_events where id = $1",
            raw_event_id,
        )
    if not row:
        raise LookupError(f"raw_event not found: {raw_event_id}")
    plaintext = decrypt_raw_content(bytes(row["raw_content"]))
    return json.loads(plaintext.decode("utf-8"))


async def purge_expired_raw_events() -> int:
    """Delete raw events past expires_at (default 30 days from insert).

    Cross-tenant job — caller must initialise the shared pool with DATABASE_URL
    (admin / bypass), e.g. jobs.cleanup.purge_raw.
    """
    now = datetime.now(timezone.utc)
    log.info("Purging raw events with expires_at < %s", now.isoformat())

    pool = get_db_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "delete from public.raw_events where expires_at < $1",
            now,
        )
    deleted_count = int(result.split()[-1]) if result else 0
    log.info("Purged %d raw events", deleted_count)
    return deleted_count
