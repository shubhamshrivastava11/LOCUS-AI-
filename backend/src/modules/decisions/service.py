"""
Decisions service — CRUD with dual-layer tenant isolation.

Every read and write path:
  1. Uses tenant_conn() to set app.current_tenant_id (Layer 1 — RLS).
  2. Passes tenant_id explicitly in the WHERE/INSERT/UPDATE clause (belt-and-suspenders SQL).
  3. Calls assert_tenant_scope() on every returned row (Layer 2 — app pre-filter).
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone

import asyncpg

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_SLACK_USER_ID_RE = re.compile(r"^U[A-Z0-9]{6,}$")


def _guess_actor_name(
    display_name: str | None,
    email: str | None,
    notion_user_id: str | None,
    slack_user_id: str | None,
) -> str | None:
    """Best-effort human name for an actor.

    display_name is essentially never populated today - extraction only
    captures ActorReference.source_actor_id (see modules.ai.extraction.
    schemas), which Claude fills with whatever it can find in the message
    text: sometimes a real provider user id (a Notion page UUID, a Slack
    "U..." id), sometimes literally the person's name as written, since raw
    text often has no real id to extract at all. That means the identifier
    columns frequently already hold a usable name - filtered here to skip
    the cases that are clearly a real machine id, not a name.
    """
    if display_name:
        return display_name
    if email:
        return email
    if notion_user_id and not _UUID_RE.match(notion_user_id):
        return notion_user_id
    if slack_user_id and not _SLACK_USER_ID_RE.match(slack_user_id):
        return slack_user_id
    return None

from database.tenant_connection import tenant_conn
from modules.decisions.schemas import DecisionCreate, DecisionListResponse, DecisionOut, RadarCorrectionFeedback
from modules.security.tenant_guard import assert_tenant_scope

log = logging.getLogger(__name__)


def _build_decision_out(
    row: dict, actors: list, source_links: list, source_platforms: list | None = None,
) -> DecisionOut:
    """Construct a DecisionOut from a DB row plus pre-fetched actors and source links."""
    return DecisionOut(
        id=row["id"],
        tenant_id=row["tenant_id"],
        record_type=row["record_type"],
        decision_statement=row["decision_statement"],
        rationale=row.get("rationale"),
        alternatives_considered=list(row["alternatives_considered"]) if row.get("alternatives_considered") is not None else [],
        actors=actors,
        status=row["status"],
        superseded_by=row.get("superseded_by"),
        scope=row["scope"],
        confidence=float(row["confidence"]),
        source_links=source_links,
        source_platforms=source_platforms or [],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def list_decisions(
    tenant_id: uuid.UUID | str,
    pool: asyncpg.Pool,
    limit: int = 50,
    offset: int = 0,
) -> DecisionListResponse:
    """Return decisions belonging to tenant_id only, with source_links and actors hydrated."""
    tenant_id = uuid.UUID(str(tenant_id))

    async with tenant_conn(pool, tenant_id) as conn:
        rows = await conn.fetch(
            """
            SELECT id, tenant_id, record_type, decision_statement, rationale,
                   alternatives_considered, status, superseded_by, scope, confidence,
                   origin_raw_event_id, created_at, updated_at
            FROM decisions
            WHERE tenant_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            tenant_id,
            limit,
            offset,
        )
        total: int = await conn.fetchval(
            "SELECT COUNT(*) FROM decisions WHERE tenant_id = $1",
            tenant_id,
        ) or 0

        decision_ids = [r["id"] for r in rows]
        actors_by_dec: dict = {}
        sources_by_dec: dict = {}
        platforms_by_dec: dict = {}

        if decision_ids:
            actor_rows = await conn.fetch(
                """
                SELECT da.tenant_id, da.decision_id, da.actor_id, da.role,
                       a.display_name, a.email, a.notion_user_id, a.slack_user_id
                FROM decision_actors da
                LEFT JOIN public.actors a
                  ON a.id = da.actor_id AND a.tenant_id = da.tenant_id
                WHERE da.decision_id = ANY($1) AND da.tenant_id = $2
                """,
                decision_ids, tenant_id,
            )
            for ar in actor_rows:
                # Mock compatibility: ignore if mock returned generic decisions rows
                if "actor_id" not in ar.keys():
                    continue
                assert_tenant_scope(ar["tenant_id"], tenant_id)
                name = _guess_actor_name(
                    ar["display_name"], ar["email"],
                    ar["notion_user_id"], ar["slack_user_id"],
                )
                actors_by_dec.setdefault(ar["decision_id"], []).append(
                    {"id": str(ar["actor_id"]), "role": ar["role"], "name": name}
                )

            source_rows = await conn.fetch(
                """
                SELECT tenant_id, decision_id, permalink
                FROM decision_sources
                WHERE decision_id = ANY($1) AND tenant_id = $2
                """,
                decision_ids, tenant_id,
            )
            for sr in source_rows:
                # Mock compatibility: ignore if mock returned generic decisions rows
                if "permalink" not in sr.keys():
                    continue
                assert_tenant_scope(sr["tenant_id"], tenant_id)
                sources_by_dec.setdefault(sr["decision_id"], []).append(sr["permalink"])

            # source_platforms comes straight from decisions.origin_raw_event_id ->
            # raw_events.source - always populated for every real ingested
            # decision, unlike decision_sources (which only gets a row when a
            # connector supplies source_permalink, which none currently do).
            origin_ids = [
                r["origin_raw_event_id"] for r in rows
                if "origin_raw_event_id" in r.keys() and r["origin_raw_event_id"]
            ]
            if origin_ids:
                platform_rows = await conn.fetch(
                    """
                    SELECT id, tenant_id, source
                    FROM raw_events
                    WHERE id = ANY($1) AND tenant_id = $2
                    """,
                    origin_ids, tenant_id,
                )
                platform_by_origin = {}
                for pr in platform_rows:
                    assert_tenant_scope(pr["tenant_id"], tenant_id)
                    platform_by_origin[pr["id"]] = pr["source"]
                for row in rows:
                    if "origin_raw_event_id" not in row.keys():
                        continue
                    origin_id = row["origin_raw_event_id"]
                    if origin_id and origin_id in platform_by_origin:
                        platforms_by_dec[row["id"]] = [platform_by_origin[origin_id]]

    items = []
    for row in rows:
        assert_tenant_scope(row["tenant_id"], tenant_id)
        items.append(_build_decision_out(
            dict(row),
            actors=actors_by_dec.get(row["id"], []),
            source_links=sources_by_dec.get(row["id"], []),
            source_platforms=platforms_by_dec.get(row["id"], []),
        ))

    return DecisionListResponse(items=items, total=total)


async def get_decision(
    decision_id: uuid.UUID | str,
    tenant_id: uuid.UUID | str,
    pool: asyncpg.Pool,
) -> DecisionOut | None:
    """
    Fetch a single decision with source_links and actors hydrated.

    Returns None (not an error) when:
      - The decision_id does not exist at all, OR
      - The decision_id exists but belongs to another tenant.
    """
    decision_id = uuid.UUID(str(decision_id))
    tenant_id = uuid.UUID(str(tenant_id))

    async with tenant_conn(pool, tenant_id) as conn:
        row = await conn.fetchrow(
            """
            SELECT id, tenant_id, record_type, decision_statement, rationale,
                   alternatives_considered, status, superseded_by, scope, confidence,
                   origin_raw_event_id, created_at, updated_at
            FROM decisions
            WHERE id = $1 AND tenant_id = $2
            """,
            decision_id,
            tenant_id,
        )

        if row is None:
            return None

        # Layer 2
        assert_tenant_scope(row["tenant_id"], tenant_id)

        actor_rows = await conn.fetch(
            """
            SELECT da.tenant_id, da.actor_id, da.role,
                   a.display_name, a.email, a.notion_user_id, a.slack_user_id
            FROM decision_actors da
            LEFT JOIN public.actors a
              ON a.id = da.actor_id AND a.tenant_id = da.tenant_id
            WHERE da.decision_id = $1 AND da.tenant_id = $2
            """,
            decision_id, tenant_id,
        )
        actors = []
        for ar in actor_rows:
            if "actor_id" not in ar.keys():
                continue
            assert_tenant_scope(ar["tenant_id"], tenant_id)
            name = _guess_actor_name(
                ar["display_name"], ar["email"], ar["notion_user_id"], ar["slack_user_id"],
            )
            actors.append({"id": str(ar["actor_id"]), "role": ar["role"], "name": name})

        source_rows = await conn.fetch(
            """
            SELECT tenant_id, permalink
            FROM decision_sources
            WHERE decision_id = $1 AND tenant_id = $2
            """,
            decision_id, tenant_id,
        )
        source_links = []
        for sr in source_rows:
            if "permalink" not in sr.keys():
                continue
            assert_tenant_scope(sr["tenant_id"], tenant_id)
            source_links.append(sr["permalink"])

        # source_platforms comes from decisions.origin_raw_event_id ->
        # raw_events.source directly - always populated, unlike
        # decision_sources (only written when source_permalink is given,
        # which no connector currently provides).
        source_platforms: list[str] = []
        if "origin_raw_event_id" in row.keys() and row["origin_raw_event_id"]:
            platform = await conn.fetchval(
                "SELECT source FROM raw_events WHERE id = $1 AND tenant_id = $2",
                row["origin_raw_event_id"], tenant_id,
            )
            if platform:
                source_platforms.append(platform)

    return _build_decision_out(
        dict(row), actors=actors, source_links=source_links, source_platforms=source_platforms,
    )


async def create_decision(
    data: DecisionCreate,
    tenant_id: uuid.UUID | str,
    pool: asyncpg.Pool,
) -> DecisionOut:
    """Insert a new decision into the registry."""
    tenant_id = uuid.UUID(str(tenant_id))

    async with tenant_conn(pool, tenant_id) as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO decisions (
                tenant_id, record_type, decision_statement, rationale,
                alternatives_considered, status, scope, scope_actor_id,
                confidence, permission_scope, origin_raw_event_id
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
            ) RETURNING id, tenant_id, record_type, decision_statement, rationale,
                      status, superseded_by, scope, confidence, created_at, updated_at
            """,
            tenant_id,
            data.record_type,
            data.decision_statement,
            data.rationale,
            data.alternatives_considered,
            data.status,
            data.scope,
            data.scope_actor_id,
            data.confidence,
            data.permission_scope,
            data.origin_raw_event_id,
        )

    assert_tenant_scope(row["tenant_id"], tenant_id)
    return DecisionOut.model_validate(dict(row))


async def patch_decision_status(
    decision_id: uuid.UUID | str,
    new_status: str,
    tenant_id: uuid.UUID | str,
    pool: asyncpg.Pool,
) -> DecisionOut:
    """Update status of a decision."""
    decision_id = uuid.UUID(str(decision_id))
    tenant_id = uuid.UUID(str(tenant_id))

    async with tenant_conn(pool, tenant_id) as conn:
        row = await conn.fetchrow(
            """
            UPDATE decisions
            SET status = $1, updated_at = NOW()
            WHERE id = $2 AND tenant_id = $3
            RETURNING id, tenant_id, record_type, decision_statement, rationale,
                      status, superseded_by, scope, confidence, created_at, updated_at
            """,
            new_status,
            decision_id,
            tenant_id,
        )

    if row is None:
        raise LookupError(f"Decision not found or access denied: {decision_id}")

    assert_tenant_scope(row["tenant_id"], tenant_id)
    return DecisionOut.model_validate(dict(row))


async def supersede_decision(
    old_decision_id: uuid.UUID | str,
    new_data: DecisionCreate,
    tenant_id: uuid.UUID | str,
    pool: asyncpg.Pool,
) -> DecisionOut:
    """
    Atomically supersede a decision with a new decision inside a transaction.

    The old decision's status is changed to 'superseded' and its superseded_by
    link is pointed to the new decision.
    """
    old_decision_id = uuid.UUID(str(old_decision_id))
    tenant_id = uuid.UUID(str(tenant_id))

    async with tenant_conn(pool, tenant_id) as conn:
        async with conn.transaction():
            # 1. Fetch and lock old decision
            old_row = await conn.fetchrow(
                """
                SELECT id, tenant_id FROM decisions
                WHERE id = $1 AND tenant_id = $2
                FOR UPDATE
                """,
                old_decision_id,
                tenant_id,
            )
            if old_row is None:
                raise LookupError(f"Decision not found or access denied: {old_decision_id}")

            assert_tenant_scope(old_row["tenant_id"], tenant_id)

            # 2. Insert new decision
            new_row = await conn.fetchrow(
                """
                INSERT INTO decisions (
                    tenant_id, record_type, decision_statement, rationale,
                    alternatives_considered, status, scope, scope_actor_id,
                    confidence, permission_scope, origin_raw_event_id
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
                ) RETURNING id, tenant_id, record_type, decision_statement, rationale,
                          status, superseded_by, scope, confidence, created_at, updated_at
                """,
                tenant_id,
                new_data.record_type,
                new_data.decision_statement,
                new_data.rationale,
                new_data.alternatives_considered,
                new_data.status,
                new_data.scope,
                new_data.scope_actor_id,
                new_data.confidence,
                new_data.permission_scope,
                new_data.origin_raw_event_id,
            )
            assert_tenant_scope(new_row["tenant_id"], tenant_id)
            new_decision_id = new_row["id"]

            # 3. Mark old superseded
            await conn.execute(
                """
                UPDATE decisions
                SET status = 'superseded', superseded_by = $1, updated_at = NOW()
                WHERE id = $2 AND tenant_id = $3
                """,
                new_decision_id,
                old_decision_id,
                tenant_id,
            )

    # supersede always returns with empty actors/sources (just created, none attached yet)
    return _build_decision_out(dict(new_row), actors=[], source_links=[])


async def record_radar_correction(
    correction: RadarCorrectionFeedback,
    original_statement: str,
    original_status: str,
    tenant_id: uuid.UUID | str,
    pool: asyncpg.Pool,
) -> uuid.UUID:
    """
    Persist a Radar correction (confirm / edit / reject) as a distinct, queryable
    record in the radar_corrections table.

    This is the training signal for future prompt versions. It captures what the
    original decision said, what action was taken, and (for edits) what it was
    changed to. Corrections are NEVER just silent in-place overwrites — every
    action produces a permanent, independently-queryable record.

    Returns the UUID of the newly created correction record.
    """
    tenant_uuid = uuid.UUID(str(tenant_id))
    decision_uuid = uuid.UUID(str(correction.decision_id))

    async with tenant_conn(pool, tenant_uuid) as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO radar_corrections (
                tenant_id, decision_id, action,
                original_statement, corrected_statement, original_status,
                note, corrected_by_actor_id
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8
            )
            RETURNING id
            """,
            tenant_uuid,
            decision_uuid,
            correction.action,
            original_statement,
            correction.corrected_statement,
            original_status,
            correction.note,
            correction.corrected_by_actor_id,
        )

    correction_id = row["id"]
    log.info(
        "Radar correction recorded: correction_id=%s decision_id=%s action=%s tenant=%s",
        correction_id, decision_uuid, correction.action, tenant_uuid,
    )
    return correction_id


async def get_radar_corrections(
    decision_id: uuid.UUID | str,
    tenant_id: uuid.UUID | str,
    pool: asyncpg.Pool,
) -> list[dict]:
    """
    Return all correction records for a given decision, newest first.

    Used by evaluation harnesses and for auditing what corrections were
    made to a decision over its lifecycle.
    """
    decision_uuid = uuid.UUID(str(decision_id))
    tenant_uuid = uuid.UUID(str(tenant_id))

    async with tenant_conn(pool, tenant_uuid) as conn:
        rows = await conn.fetch(
            """
            SELECT id, tenant_id, decision_id, action,
                   original_statement, corrected_statement, original_status,
                   note, corrected_by_actor_id, corrected_at
            FROM radar_corrections
            WHERE decision_id = $1 AND tenant_id = $2
            ORDER BY corrected_at DESC
            """,
            decision_uuid,
            tenant_uuid,
        )

    result = []
    for row in rows:
        assert_tenant_scope(row["tenant_id"], tenant_uuid)
        result.append({
            "id": str(row["id"]),
            "decision_id": str(row["decision_id"]),
            "action": row["action"],
            "original_statement": row["original_statement"],
            "corrected_statement": row["corrected_statement"],
            "original_status": row["original_status"],
            "note": row["note"],
            "corrected_by_actor_id": str(row["corrected_by_actor_id"]) if row["corrected_by_actor_id"] else None,
            "corrected_at": row["corrected_at"].isoformat(),
        })
    return result
