"""
Doctor Visit Packet routes.

DESIGN:
  - Additive endpoints under the existing /jobs/{job_id} resource; nothing
    existing changes. The packet is built from the job's STORED report plus
    prior reports and the medication list — analysis is never re-run.
  - Signed-in users: profile name, medications, and report history come from
    the database (scoped to the job's profile, legacy NULL = default profile).
  - Guests: their profiles/medications/history live in localStorage, so the
    request body carries them. Access follows the same rule as GET /jobs/{id}:
    knowing the job_id grants access to guest jobs; owned jobs require the
    owner's token.
  - Packets are saved (one per job) so reopening a report reuses the stored
    packet — no duplicate LLM calls. ?regenerate=true rebuilds it.

ENDPOINTS:
  GET  /api/v1/jobs/{job_id}/packet         — fetch the saved packet
  POST /api/v1/jobs/{job_id}/packet         — build (or return saved) packet
  GET  /api/v1/jobs/{job_id}/packet/export  — download the packet as PDF
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.auth import decode_token
from db.database import get_db
from db.models import Job, Medication, Profile, User, VisitPacket
from output.packet import generate_packet
from output.report import generate_packet_pdf

router = APIRouter(prefix="/api/v1", tags=["visit-packet"])


# ── REQUEST SCHEMAS (guest supplements) ───────────────────

class PriorFinding(BaseModel):
    parameter: str = Field("", max_length=120)
    numeric_value: float | None = None
    unit: str | None = Field(None, max_length=40)
    status: str | None = Field(None, max_length=20)
    ref_low: float | None = None
    ref_high: float | None = None


class PriorReport(BaseModel):
    job_id: str | None = Field(None, max_length=64)
    created_at: str | None = Field(None, max_length=40)
    findings: list[PriorFinding] = Field(default_factory=list, max_length=40)


class PacketRequest(BaseModel):
    """Optional context a guest client supplies from localStorage. Ignored for
    signed-in users — the server's own data is authoritative there."""
    profile_name: str | None = Field(None, max_length=120)
    medications: list[str] = Field(default_factory=list, max_length=12)
    prior_reports: list[PriorReport] = Field(default_factory=list, max_length=30)


# ── HELPERS ───────────────────────────────────────────────

async def _resolve_user(authorization: str, db: AsyncSession) -> User | None:
    """Bearer token → User, or None for guests/invalid tokens."""
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        return None
    email = decode_token(token)
    if not email:
        return None
    result = await db.execute(select(User).where(User.email == email))
    return result.scalar_one_or_none()


async def _get_owned_job(job_id: str, user: User | None, db: AsyncSession) -> Job:
    """Load the job; owned jobs are only visible to their owner."""
    result = await db.execute(select(Job).where(Job.job_id == job_id))
    job = result.scalar_one_or_none()
    if not job or (job.user_id and (not user or job.user_id != user.id)):
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


async def _job_profile(job: Job, user: User, db: AsyncSession) -> Profile:
    """The profile a job belongs to (NULL = the user's default profile)."""
    if job.profile_id:
        result = await db.execute(
            select(Profile).where(Profile.id == job.profile_id, Profile.user_id == user.id)
        )
        profile = result.scalar_one_or_none()
        if profile:
            return profile
    from api.profiles import ensure_default_profile
    return await ensure_default_profile(user, db)


def _compact_findings(report: dict) -> list[dict]:
    return [
        {
            "parameter": f.get("parameter"),
            "numeric_value": f.get("numeric_value"),
            "unit": f.get("unit"),
            "status": f.get("status"),
            "ref_low": f.get("ref_low"),
            "ref_high": f.get("ref_high"),
        }
        for f in (report.get("findings") or [])
    ]


async def _server_context(job: Job, user: User, db: AsyncSession) -> tuple[str, list[str], list[dict]]:
    """Profile name, medications, and prior report entries from the DB."""
    profile = await _job_profile(job, user, db)
    display_name = profile.name if profile.is_default else f"{profile.name} ({profile.relation})"

    meds_result = await db.execute(
        select(Medication)
        .where(Medication.user_id == user.id, Medication.profile_id == profile.id)
        .order_by(Medication.created_at)
    )
    medications = [m.name for m in meds_result.scalars().all()]

    profile_filter = (
        (Job.profile_id == profile.id) | (Job.profile_id.is_(None))
        if profile.is_default
        else (Job.profile_id == profile.id)
    )
    jobs_result = await db.execute(
        select(Job)
        .where(Job.user_id == user.id, Job.status == "completed", profile_filter)
        .order_by(Job.created_at.asc())
        .limit(30)
    )
    entries = [
        {
            "date": j.created_at.isoformat() if j.created_at else None,
            "findings": _compact_findings(j.result or {}),
        }
        for j in jobs_result.scalars().all()
    ]
    return display_name, medications, entries


def _guest_context(job: Job, body: PacketRequest) -> tuple[str, list[str], list[dict]]:
    """Profile name, medications, and prior entries from the request body."""
    medications = [m.strip()[:120] for m in body.medications if m and m.strip()][:12]
    entries = [
        {"date": p.created_at, "findings": [f.model_dump() for f in p.findings]}
        for p in body.prior_reports
        if p.job_id != job.job_id
    ]
    entries.append({
        "date": job.created_at.isoformat() if job.created_at else None,
        "findings": _compact_findings(job.result or {}),
    })
    return (body.profile_name or "").strip(), medications, entries


async def _saved_packet(job_id: str, db: AsyncSession) -> VisitPacket | None:
    result = await db.execute(select(VisitPacket).where(VisitPacket.job_id == job_id))
    return result.scalar_one_or_none()


# ── ENDPOINTS ─────────────────────────────────────────────

@router.get("/jobs/{job_id}/packet")
async def get_packet(
    job_id: str,
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    """Return the saved visit packet for a job (404 if none was generated)."""
    user = await _resolve_user(authorization, db)
    await _get_owned_job(job_id, user, db)
    saved = await _saved_packet(job_id, db)
    if not saved:
        raise HTTPException(status_code=404, detail="No packet generated for this report yet.")
    return saved.content


@router.post("/jobs/{job_id}/packet")
async def create_packet(
    job_id: str,
    body: PacketRequest | None = None,
    regenerate: bool = False,
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    """Build the visit packet from the stored report (and save it). Returns
    the previously saved packet unless ?regenerate=true — this is what keeps
    LLM usage to at most one call per packet."""
    body = body or PacketRequest()
    user = await _resolve_user(authorization, db)
    job = await _get_owned_job(job_id, user, db)

    if job.status != "completed" or not job.result:
        raise HTTPException(status_code=400, detail="The report is not ready yet.")

    saved = await _saved_packet(job_id, db)
    if saved and not regenerate:
        return saved.content

    if user and job.user_id:
        profile_name, medications, entries = await _server_context(job, user, db)
    else:
        profile_name, medications, entries = _guest_context(job, body)

    packet = await generate_packet(
        job_id,
        job.result,
        profile_name=profile_name,
        report_date=job.created_at.isoformat() if job.created_at else None,
        medications=medications,
        prior_entries=entries,
    )

    if saved:
        saved.content = packet
    else:
        db.add(VisitPacket(
            job_id=job_id,
            user_id=job.user_id,
            profile_id=job.profile_id,
            content=packet,
        ))
    await db.commit()
    return packet


@router.get("/jobs/{job_id}/packet/export")
async def export_packet(
    job_id: str,
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    """Download the saved visit packet as a PDF."""
    user = await _resolve_user(authorization, db)
    await _get_owned_job(job_id, user, db)
    saved = await _saved_packet(job_id, db)
    if not saved:
        raise HTTPException(status_code=404, detail="Generate the packet first.")

    pdf_path = generate_packet_pdf(job_id, saved.content)
    return FileResponse(
        path=pdf_path,
        media_type="application/pdf",
        filename=f"clearchart-visit-packet-{job_id[:8]}.pdf",
    )
