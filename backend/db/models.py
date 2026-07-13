"""
SQLAlchemy ORM models.

WHY ONE TABLE FOR THE DEMO?
  The Job table stores everything we need: who uploaded what,
  processing status, and the final JSON report. For a production
  system you'd split this into Users, Documents, Reports — but
  for a demo, one table is faster to build and easier to explain.

STATELESS DESIGN (important for scaling):
  The FastAPI server stores NOTHING in memory about jobs.
  Every request reads/writes this table. This means:
  - You can run 10 FastAPI instances behind a load balancer
    and any instance can handle any request.
  - If the server crashes, no job state is lost.
  This is the "stateless web tier" principle from your checklist.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Integer, String, Text, JSON, UniqueConstraint

from db.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    """
    A registered ClearChart user.

    Passwords are stored as PBKDF2-HMAC-SHA256 hashes (salt$hash) — no
    plaintext ever touches the database. Sessions are stateless HMAC-signed
    tokens, so this table stays small and the web tier stays stateless.
    """
    __tablename__ = "users"

    id            = Column(String(36), primary_key=True, default=_uuid)
    email         = Column(String(255), unique=True, nullable=False, index=True)
    name          = Column(String(120), nullable=False)
    password_hash = Column(String(255), nullable=False)
    created_at    = Column(DateTime(timezone=True), default=_now, nullable=False)


class Profile(Base):
    """
    A health profile under one account — "Me", "Mother", "Child", …

    Reports, medications, timelines, and chat context are all scoped to a
    profile. Every user gets a default profile on first access; legacy jobs
    created before profiles existed (profile_id IS NULL) are shown under it,
    which keeps old accounts working unchanged.
    """
    __tablename__ = "profiles"

    id         = Column(String(36), primary_key=True, default=_uuid)
    user_id    = Column(String(36), nullable=False, index=True)
    name       = Column(String(80), nullable=False)
    relation   = Column(String(40), nullable=False, default="Self")   # Self | Mother | Father | Child | ...
    is_default = Column(Integer, nullable=False, default=0)           # 1 for the auto-created profile
    created_at = Column(DateTime(timezone=True), default=_now, nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "relation": self.relation,
            "is_default": bool(self.is_default),
        }


class Medication(Base):
    """
    A medication on a profile's review list. Only the name is stored —
    all interaction/label information is retrieved live from authoritative
    sources (openFDA / DailyMed) at analysis time, never persisted.
    """
    __tablename__ = "medications"

    id         = Column(String(36), primary_key=True, default=_uuid)
    user_id    = Column(String(36), nullable=False, index=True)
    profile_id = Column(String(36), nullable=False, index=True)
    name       = Column(String(120), nullable=False)
    created_at = Column(DateTime(timezone=True), default=_now, nullable=False)

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "profile_id": self.profile_id}


class VisitPacket(Base):
    """
    A saved "Doctor Visit Packet" for one completed analysis job.

    The packet is assembled from data the system has already produced (the
    job's stored report, prior reports, the medication list) — analysis is
    never re-run. One packet per job; regenerating overwrites the content.
    Purely additive table: nothing else references it.
    """
    __tablename__ = "visit_packets"

    id         = Column(String(36), primary_key=True, default=_uuid)
    job_id     = Column(String(36), nullable=False, unique=True, index=True)
    user_id    = Column(String(36), nullable=True, index=True)
    profile_id = Column(String(36), nullable=True)
    content    = Column(JSON, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)


class ReportComparison(Base):
    """
    A saved comparison between two completed reports (Report Comparison Mode).

    The diff itself is deterministic and cheap; what makes saving worth it is
    the optional LLM summary — one row per ordered pair means at most one LLM
    call per pair, ever. Jobs are normalised so older_job_id is always the
    earlier report. Purely additive table.
    """
    __tablename__ = "report_comparisons"
    __table_args__ = (UniqueConstraint("older_job_id", "newer_job_id", name="uq_comparison_pair"),)

    id           = Column(String(36), primary_key=True, default=_uuid)
    older_job_id = Column(String(36), nullable=False, index=True)
    newer_job_id = Column(String(36), nullable=False, index=True)
    user_id      = Column(String(36), nullable=True, index=True)
    profile_id   = Column(String(36), nullable=True)
    content      = Column(JSON, nullable=False)
    created_at   = Column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at   = Column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)


class Recommendation(Base):
    """
    One follow-up recommendation from the Follow-up Tracker.

    Generated deterministically from a completed report's rule-validated
    findings (analysis/recommendations.py) the first time the tracker is
    opened, then owned by the user: completion state and personal notes
    persist here across sessions. Linked to the originating report via
    job_id and scoped to a profile. Purely additive table.
    """
    __tablename__ = "recommendations"

    id           = Column(String(36), primary_key=True, default=_uuid)
    job_id       = Column(String(36), nullable=False, index=True)
    user_id      = Column(String(36), nullable=True, index=True)
    profile_id   = Column(String(36), nullable=True, index=True)
    parameter    = Column(String(120), nullable=True)     # null = generic advice
    action       = Column(Text, nullable=False)
    reason       = Column(Text, nullable=False)
    priority     = Column(String(10), nullable=False, default="medium")   # high | medium | low
    citation     = Column(JSON, nullable=True)            # {source, url}
    completed    = Column(Integer, nullable=False, default=0)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    note         = Column(String(500), nullable=True)
    reason_source = Column(String(16), nullable=False, default="deterministic")  # deterministic | llm
    created_at   = Column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at   = Column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "job_id": self.job_id,
            "parameter": self.parameter,
            "action": self.action,
            "reason": self.reason,
            "priority": self.priority,
            "citation": self.citation,
            "completed": bool(self.completed),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "note": self.note,
            "reason_source": self.reason_source,
        }


class Job(Base):
    """
    Represents one analysis job.

    Lifecycle: pending → processing → completed | failed
    """
    __tablename__ = "jobs"

    # ── Primary key ───────────────────────────────────────
    job_id = Column(String(36), primary_key=True, default=_uuid)

    # ── Status ────────────────────────────────────────────
    # "pending" | "processing" | "completed" | "failed"
    status   = Column(String(20), nullable=False, default="pending", index=True)
    progress = Column(Integer, nullable=False, default=0)   # 0–100

    # ── Ownership ─────────────────────────────────────────
    # Set when the request carried a valid auth token; null for guests.
    # Powers the "My reports" history + trends feature.
    user_id    = Column(String(36), nullable=True, index=True)
    # Which family profile this report belongs to. Null = created before
    # profiles existed → attributed to the user's default profile.
    profile_id = Column(String(36), nullable=True, index=True)

    # ── Input metadata ────────────────────────────────────
    source_name   = Column(String(255), nullable=True)   # filename or "pasted-text"
    file_path     = Column(String(512), nullable=True)   # local path to uploaded file
    input_type    = Column(String(20),  nullable=True)   # "file" | "text"

    # ── Output ────────────────────────────────────────────
    # Storing the full report as JSON. In production you'd normalise
    # this into a Reports table with FK. For the demo, JSON is fine.
    result = Column(JSON, nullable=True)
    error  = Column(Text, nullable=True)

    # ── Timestamps ────────────────────────────────────────
    created_at  = Column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at  = Column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    def to_status_dict(self) -> dict:
        """Serialise to the shape JobStatusResponse expects."""
        return {
            "job_id":   self.job_id,
            "status":   self.status,
            "progress": self.progress,
            "result":   self.result,
            "error":    self.error,
        }
