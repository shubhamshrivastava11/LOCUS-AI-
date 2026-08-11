"""
Retrieval router — API endpoints for natural language QA over retrieved decisions.

/ask delegates its retrieval to modules.search.service.search() - the exact
same query understanding -> hybrid retrieval -> RRF -> permission filtering
-> cross-encoder reranking -> structured context -> Claude answer pipeline
/search uses. It previously ran its own, separate FTS-only query
(modules.retrieval.service.retrieve_decisions()) that never called
modules.permissions.service.filter_accessible_decisions() - a real
permission-filtering gap, found in code review, fixed here by removing the
second retrieval implementation rather than patching it to match the first
one field-by-field. modules.retrieval.service.retrieve_decisions() /
get_decision_context() / synthesize_answer() are left in place (unused by
this router now, but not deleted - they still have their own passing unit
tests and nothing else in the request path depends on this change touching
them).
"""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator, Dict, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.dependencies import TenantContext, get_current_tenant
from database.pool import get_db_pool
from modules.permissions.scope_resolver import resolve_permission_scopes
from modules.search.service import search as run_search_pipeline

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/retrieval", tags=["retrieval"])


class AskRequest(BaseModel):
    query: str = Field(..., description="The natural language question to ask")
    filters: Optional[Dict[str, Any]] = Field(
        None,
        description=(
            "Deprecated/unsupported: the unified retrieval pipeline (shared with /search) "
            "does not filter by status/confidence_min/actor/date_range. Accepted for request-"
            "schema compatibility only; a non-null value is logged and otherwise ignored."
        ),
    )
    limit: int = Field(10, ge=1, le=50, description="Max decisions to retrieve (passed through as top_k)")
    offset: int = Field(
        0, ge=0,
        description="Deprecated/unsupported: the unified retrieval pipeline has no pagination offset. "
                     "A non-zero value is logged and otherwise ignored.",
    )


async def _stream_search_result(question: str, ctx: TenantContext, pool, top_k: int) -> AsyncGenerator[bytes, None]:
    """Run the shared /search pipeline once, then emit its result as the
    same NDJSON envelope shape /ask has always used ({"type": "content"|
    "message"|"error", "content": ...}) - one chunk instead of token-by-
    token deltas, since the shared pipeline's answer generation is a single
    forced tool call (modules.answering), not an incrementally streamable
    completion. This is the one deliberate behavior change: true token-
    level streaming is not reachable while also reusing the same, already-
    permission-filtered, already-reranked answering path /search uses -
    keeping two separate answering implementations just to preserve token
    streaming would reintroduce exactly the duplication this change removes.
    """
    try:
        permission_scopes = await resolve_permission_scopes(ctx)
        result = await run_search_pipeline(pool, ctx.tenant_id, question, permission_scopes, top_k)

        # result.answer is always populated by modules.answering.service.generate_answer()
        # - either the real grounded answer, or (when sufficient_evidence is False) the
        # exact backend-enforced refusal text - so a single "content" chunk covers both
        # cases without needing a separate "no relevant decisions" branch.
        yield (json.dumps({"type": "content", "content": result.answer}) + "\n").encode()

    except Exception:
        log.exception("Retrieval QA pipeline failed")
        yield (json.dumps({"type": "error", "content": "An error occurred while generating the answer. Please try again later."}) + "\n").encode()


@router.post(
    "/ask",
    summary="Ask a question grounded in decisions (streams answer)",
)
async def ask_question(
    body: AskRequest,
    ctx: TenantContext = Depends(get_current_tenant),
) -> StreamingResponse:
    """
    Takes a question and returns a streamed, cited, permission-filtered
    answer via the same pipeline /search uses (query understanding, hybrid
    pgvector+keyword retrieval with RRF, permission filtering, cross-
    encoder reranking, structured context, Claude tool-call answering,
    backend-enforced no-answer refusal).

    Authentication is enforced via the mandatory tenant-scoped JWT; the
    tenant_id is taken exclusively from the authenticated TenantContext.
    """
    if body.filters:
        log.warning("POST /ask received unsupported 'filters' (%r); ignored by the unified retrieval pipeline.", body.filters)
    if body.offset:
        log.warning("POST /ask received unsupported non-zero 'offset' (%d); ignored by the unified retrieval pipeline.", body.offset)

    pool = get_db_pool()
    return StreamingResponse(
        _stream_search_result(body.query, ctx, pool, body.limit),
        media_type="application/x-ndjson",
    )
