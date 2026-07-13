"""
Report Comparison Mode routes.

DESIGN:
  - One additive endpoint. The diff is computed by `analysis/compare.py`
    entirely in backend code from the two jobs' STORED reports — the rule
    engine is not re-run and the LLM computes nothing.
  - Access follows the visit-packet rules: owned jobs require the owner's
    token; guest jobs are reachable by job_id (same as GET /jobs/{id}).
    For signed-in users both reports must belong to the same profile.
  - The pair is normalised (older first) and the result saved, so repeating
    the comparison is a single indexed lookup and the optional LLM summary
    is generated at most once per pair. ?regenerate=true rebuilds.

ENDPOINT:
  POST /api/v1/reports/compare   {left_job_id, right_job_id}
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from analysis.compare import build_change_records, generate_comparison
from api.packets import PriorReport, _get_owned_job, _job_profile, _resolve_user
from db.database import get_db
from db.models import Job, ReportComparison, User

router = APIRouter(prefix="/api/v1", tags=["comparisons"])


class CompareRequest(BaseModel):
    left_job_id: str = Field(..., max_length=64)
    right_job_id: str = Field(..., max_length=64)


class ChangesRequest(BaseModel):
    """Guest supplement: the most recent PRIOR report from localStorage.
    Ignored for signed-in users — the server queries their history itself."""
    prior: PriorReport | None = None


def _entry(job: Job) -> dict:
    return {
        "job_id": job.job_id,
        "date": job.created_at.isoformat() if job.created_at else None,
        "source_name": job.source_name,
        "report": job.result or {},
    }


@router.post("/jobs/{job_id}/changes")
async def changes_since_last_report(
    job_id: str,
    body: ChangesRequest | None = None,
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    """'What changed since the last report' — the deterministic diff between
    this report and the most recent completed report before it for the same
    profile. Runs on every report open, so it is pure dict math: no LLM call,
    no storage, one indexed query."""
    body = body or ChangesRequest()
    user = await _resolve_user(authorization, db)
    job = await _get_owned_job(job_id, user, db)
    if job.status != "completed" or not job.result:
        raise HTTPException(status_code=400, detail="The report is not ready yet.")

    prior_entry: dict | None = None
    if user and job.user_id:
        profile = await _job_profile(job, user, db)
        profile_filter = (
            (Job.profile_id == profile.id) | (Job.profile_id.is_(None))
            if profile.is_default
            else (Job.profile_id == profile.id)
        )
        result = await db.execute(
            select(Job)
            .where(
                Job.user_id == user.id,
                Job.status == "completed",
                Job.job_id != job.job_id,
                Job.created_at < job.created_at,
                profile_filter,
            )
            .order_by(Job.created_at.desc())
            .limit(1)
        )
        prior = result.scalar_one_or_none()
        if prior and prior.result:
            prior_entry = _entry(prior)
    elif body.prior and body.prior.findings:
        prior_entry = {
            "job_id": body.prior.job_id,
            "date": body.prior.created_at,
            "source_name": None,
            "report": {"findings": [f.model_dump() for f in body.prior.findings]},
        }

    if prior_entry is None:
        return {
            "has_prior": False,
            "message": "This is the first report for this profile. Upload another report in the future to track changes over time.",
        }

    return {"has_prior": True, **build_change_records(prior_entry, _entry(job))}


@router.post("/reports/compare")
async def compare_reports(
    body: CompareRequest,
    regenerate: bool = False,
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    """Deterministically compare two completed reports (older vs newer)."""
    if body.left_job_id == body.right_job_id:
        raise HTTPException(status_code=400, detail="Pick two different reports to compare.")

    user = await _resolve_user(authorization, db)
    job_a = await _get_owned_job(body.left_job_id, user, db)
    job_b = await _get_owned_job(body.right_job_id, user, db)

    for job in (job_a, job_b):
        if job.status != "completed" or not job.result:
            raise HTTPException(status_code=400, detail="Both reports must be completed analyses.")

    # Profile scoping: an account's reports can only be compared within one
    # profile (legacy NULL profile_id resolves to the default profile).
    if job_a.user_id != job_b.user_id:
        raise HTTPException(status_code=400, detail="These reports don't belong to the same account.")
    if user and job_a.user_id:
        profile_a = await _job_profile(job_a, user, db)
        profile_b = await _job_profile(job_b, user, db)
        if profile_a.id != profile_b.id:
            raise HTTPException(status_code=400, detail="Both reports must belong to the same profile.")

    older, newer = sorted((job_a, job_b), key=lambda j: (j.created_at is None, j.created_at))

    result = await db.execute(
        select(ReportComparison).where(
            ReportComparison.older_job_id == older.job_id,
            ReportComparison.newer_job_id == newer.job_id,
        )
    )
    saved = result.scalar_one_or_none()
    if saved and not regenerate:
        return saved.content

    comparison = await generate_comparison(_entry(older), _entry(newer))

    if saved:
        saved.content = comparison
    else:
        db.add(ReportComparison(
            older_job_id=older.job_id,
            newer_job_id=newer.job_id,
            user_id=older.user_id,
            profile_id=older.profile_id or newer.profile_id,
            content=comparison,
        ))
    await db.commit()
    return comparison
