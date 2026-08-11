"""
Locus AI — Production Search API (Phase 2).

POST /search: authenticated tenant-scoped query understanding -> retrieval
(candidate_k=20, RETRIEVAL_MODE-dependent) -> permission filter ->
cross-encoder rerank to top_k -> structured context builder -> Claude
answer (forced tool call) -> answer + reasoning + source citations.
Single-turn only: no conversation memory, no streaming, no agents.

Uses the same mandatory Depends(get_current_tenant) every other protected
route uses (decisions/router.py, retrieval/router.py) - never a
client-supplied-tenant_id fallback. tenant_id is taken exclusively from the
authenticated TenantContext; the request body carries only search inputs.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import TenantContext, get_current_tenant
from common.config.voyage_config import VoyageConfigError
from database.pool import get_db_pool
from modules.ai.embeddings.provider import VoyageEmbeddingError, VoyageResponseValidationError
from modules.answering.provider import (
    AnswerAPIError,
    AnswerResponseValidationError,
    AnswerToolCallError,
)
from modules.permissions.scope_resolver import resolve_permission_scopes
from modules.ratelimit.limiter import enforce_rate_limit
from modules.search.schemas import SearchRequest, SearchResponse
from modules.search.service import search

log = logging.getLogger(__name__)

router = APIRouter(tags=["search"])


@router.post("/search", response_model=SearchResponse)
async def search_endpoint(
    request: SearchRequest,
    ctx: TenantContext = Depends(get_current_tenant),
    _: None = Depends(enforce_rate_limit("search")),
) -> SearchResponse:
    """Production question -> grounded answer + citations endpoint."""
    pool = get_db_pool()
    permission_scopes = await resolve_permission_scopes(ctx)
    try:
        return await search(
            pool,
            ctx.tenant_id,
            request.question,
            permission_scopes,
            request.top_k,
        )
    except VoyageConfigError as exc:
        log.error("Voyage configuration error during /search: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Voyage configuration error",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except (VoyageEmbeddingError, VoyageResponseValidationError) as exc:
        log.error("Query embedding failure during /search: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="Query embedding failed"
        ) from exc
    except (AnswerAPIError, AnswerToolCallError, AnswerResponseValidationError) as exc:
        log.error("Claude answer failure during /search: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="Answer generation failed"
        ) from exc