"""
Digest Router — GET /digest returns the weekly Team Pulse or personal digest.

?scope=personal  → "Your Week in Decisions" (default)
?scope=team      → "Team Pulse" (team-wide)
?refresh=true    → force regenerate (dev / explicit refresh); otherwise prefer
                   the Monday-persisted row for the current digest week

Uses the same mandatory Depends(get_current_tenant) every other protected
route uses — tenant_id is taken exclusively from the authenticated
TenantContext, never from query params or request body.

permission_scopes are resolved server-side from the TenantContext via
resolve_permission_scopes(), exactly as /search does — never accepted from
the caller.
"""
from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.dependencies import TenantContext, get_current_tenant
from common.config.voyage_config import VoyageConfigError
from database.pool import get_db_pool
from modules.ai.embeddings.provider import VoyageEmbeddingError, VoyageResponseValidationError
from modules.answering.provider import AnswerAPIError, AnswerResponseValidationError
from modules.digest.schemas import DigestResponse
from modules.digest.service import generate_team_pulse
from modules.digest.store import digest_week_of, load_weekly_digest, save_weekly_digest
from modules.permissions.scope_resolver import resolve_permission_scopes
from modules.ratelimit.limiter import enforce_rate_limit

log = logging.getLogger(__name__)

router = APIRouter(tags=["digest"])


@router.get("/digest", response_model=DigestResponse)
async def get_digest(
    scope: Literal["personal", "team"] = Query(
        default="personal",
        description="'personal' for Your Week in Decisions, 'team' for Team Pulse",
    ),
    refresh: bool = Query(
        default=False,
        description="If true, regenerate now instead of serving the stored Monday digest",
    ),
    ctx: TenantContext = Depends(get_current_tenant),
    _: None = Depends(enforce_rate_limit("digest")),
) -> DigestResponse:
    """Return the weekly digest for the authenticated tenant member.

    Prefers the persisted Monday digest for the current week. Regenerates
    (and stores) only when no row exists or refresh=true.
    """
    pool = get_db_pool()
    permission_scopes = await resolve_permission_scopes(ctx)
    week_of = digest_week_of()
    user_id = ctx.user_id if scope == "personal" else None

    if not refresh:
        try:
            stored = await load_weekly_digest(
                pool,
                ctx.tenant_id,
                scope,
                week_of=week_of,
                user_id=user_id,
            )
            if stored is not None:
                return stored
        except Exception:
            log.exception(
                "Failed to load stored digest tenant=%s scope=%s — falling back to generate",
                ctx.tenant_id,
                scope,
            )

    try:
        digest = await generate_team_pulse(
            pool,
            ctx.tenant_id,
            permission_scopes,
            scope,
            user_id=ctx.user_id,
        )
    except VoyageConfigError as exc:
        log.error("Voyage configuration error during /digest: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Voyage configuration error",
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    except (VoyageEmbeddingError, VoyageResponseValidationError) as exc:
        log.error("Query embedding failure during /digest: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="Query embedding failed"
        ) from exc
    except (AnswerAPIError, AnswerResponseValidationError) as exc:
        log.error("Claude answer failure during /digest: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="Digest generation failed"
        ) from exc

    try:
        await save_weekly_digest(
            pool,
            ctx.tenant_id,
            digest,
            week_of,
            user_id=user_id,
        )
    except Exception:
        log.exception(
            "Failed to persist digest after generate tenant=%s scope=%s",
            ctx.tenant_id,
            scope,
        )

    return digest
