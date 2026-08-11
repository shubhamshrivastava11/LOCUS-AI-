"""
Decision schemas.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class ActorRef(BaseModel):
    """A decision actor with their role and, when known, a real name."""
    id: str
    role: str
    name: Optional[str] = None


class DecisionOut(BaseModel):
    """A single decision record returned to the caller."""
    id: uuid.UUID
    tenant_id: uuid.UUID
    record_type: str
    decision_statement: str
    rationale: Optional[str] = None
    alternatives_considered: list[str] = Field(default_factory=list)
    actors: list[ActorRef] = Field(default_factory=list)
    status: str
    superseded_by: Optional[uuid.UUID] = None
    scope: str
    confidence: float
    source_links: list[str] = Field(default_factory=list)
    source_platforms: list[str] = Field(
        default_factory=list,
        description="Distinct originating platforms ('gmail'/'slack'/'notion') this decision was captured from.",
    )
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DecisionCreate(BaseModel):
    """Input payload for creating a new decision."""
    record_type: str = "decision"
    decision_statement: str
    rationale: Optional[str] = None
    alternatives_considered: list[str] = []
    status: str = "proposed"
    scope: str = "team"
    scope_actor_id: Optional[uuid.UUID] = None
    confidence: float = 1.0
    permission_scope: list[str] = []
    origin_raw_event_id: Optional[uuid.UUID] = None


class StatusUpdate(BaseModel):
    """Input payload for updating decision status."""
    status: str


class RadarCorrectionFeedback(BaseModel):
    """
    Captures a user correction on a Radar decision as a training signal.
    Written to radar_corrections whenever a decision is confirmed, edited, or rejected.

    action must be one of: 'confirmed' | 'edited' | 'rejected'
    corrected_statement is required when action == 'edited'.
    """
    decision_id: uuid.UUID
    action: str
    corrected_statement: Optional[str] = None  # populated for 'edited' actions
    note: Optional[str] = None
    corrected_by_actor_id: Optional[uuid.UUID] = None


class DecisionListResponse(BaseModel):
    items: list[DecisionOut]
    total: int

