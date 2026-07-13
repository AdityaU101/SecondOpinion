"""
Follow-up Recommendation Tracker routes.

DESIGN:
  - Recommendations are generated ONCE per report (first open of the
    tracker) by the deterministic rule table in analysis/recommendations.py,
    then persisted — completion state and notes live in the DB, so ticking a
    checkbox is a tiny UPDATE and never re-runs generation or the LLM.
  - Access mirrors the visit-packet rules: owned jobs need the owner's
    token; guest jobs are reachable by job_id, so guests get full
    persistence too (their jobs already live server-side).
  - The pending list powers the History page card: profile-scoped for
    accounts, job_id-list for guests (whose history index lives on-device).

ENDPOINTS:
  POST  /api/v1/jobs/{job_id}/recommendations   — generate-or-return the report's recs
  PATCH /api/v1/recommendations/{rec_id}        — completion state / personal note
  GET   /api/v1/recommendations/pending         — open items (?profile_id= or ?job_ids=)
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from analysis.recommendations import generate_recommendations, polish_reasons
from api.packets import _get_owned_job, _resolve_user
from db.database import get_db
from db.models import Job, Recommendation

router = APIRouter(prefix="/api/v1", tags=["recommendations"])


class RecommendationUpdate(BaseModel):
    completed: bool | None = None
    note: str | None = Field(None, max_length=500)


@router.post("/jobs/{job_id}/recommendations")
async def get_or_create_recommendations(
    job_id: str,
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    """Return the report's recommendations, generating them on first open."""
    user = await _resolve_user(authorization, db)
    job = await _get_owned_job(job_id, user, db)
    if job.status != "completed" or not job.result:
        raise HTTPException(status_code=400, detail="The report is not ready yet.")

    result = await db.execute(
        select(Recommendation).where(Recommendation.job_id == job_id).order_by(Recommendation.created_at)
    )
    existing = result.scalars().all()
    if existing:
        return {"recommendations": [r.to_dict() for r in existing]}

    recs = generate_recommendations(job.result)
    polished = await polish_reasons(recs)   # optional; deterministic text kept on any failure

    rows = [
        Recommendation(
            job_id=job_id,
            user_id=job.user_id,
            profile_id=job.profile_id,
            parameter=r["parameter"],
            action=r["action"],
            reason=r["reason"],
            priority=r["priority"],
            citation=r["citation"],
            reason_source="llm" if polished else "deterministic",
        )
        for r in recs
    ]
    db.add_all(rows)
    await db.commit()
    return {"recommendations": [r.to_dict() for r in rows]}


@router.patch("/recommendations/{rec_id}")
async def update_recommendation(
    rec_id: str,
    body: RecommendationUpdate,
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    """Toggle completion / edit the personal note. State-only — generation
    and the LLM are never re-run here."""
    user = await _resolve_user(authorization, db)
    result = await db.execute(select(Recommendation).where(Recommendation.id == rec_id))
    rec = result.scalar_one_or_none()
    if not rec or (rec.user_id and (not user or rec.user_id != user.id)):
        raise HTTPException(status_code=404, detail="Recommendation not found.")

    if body.completed is not None:
        rec.completed = 1 if body.completed else 0
        rec.completed_at = datetime.now(timezone.utc) if body.completed else None
    if body.note is not None:
        rec.note = body.note.strip() or None
    await db.commit()
    return rec.to_dict()


@router.get("/recommendations/pending")
async def pending_recommendations(
    profile_id: str | None = Query(default=None),
    job_ids: str | None = Query(default=None, max_length=2000),
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    """Open follow-ups for the History page. Signed-in: scoped to a profile
    (legacy NULL profile = default). Guests: pass their history's job ids."""
    user = await _resolve_user(authorization, db)

    if user:
        from api.profiles import resolve_profile
        profile = await resolve_profile(user, profile_id, db)
        profile_filter = (
            (Recommendation.profile_id == profile.id) | (Recommendation.profile_id.is_(None))
            if profile.is_default
            else (Recommendation.profile_id == profile.id)
        )
        query = select(Recommendation).where(
            Recommendation.user_id == user.id,
            Recommendation.completed == 0,
            profile_filter,
        )
    else:
        ids = [j.strip() for j in (job_ids or "").split(",") if j.strip()][:40]
        if not ids:
            return {"recommendations": []}
        query = select(Recommendation).where(
            Recommendation.user_id.is_(None),
            Recommendation.completed == 0,
            Recommendation.job_id.in_(ids),
        )

    result = await db.execute(query.order_by(Recommendation.created_at.desc()).limit(50))
    return {"recommendations": [r.to_dict() for r in result.scalars().all()]}
