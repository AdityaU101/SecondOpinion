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

from sqlalchemy import Column, DateTime, Integer, String, Text, JSON

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
