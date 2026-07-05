"""
API routes — the stateless web tier.

DESIGN (maps to the system-design checklist):
  - POST /analyze/* creates a job row (status=pending) and returns 202 instantly.
    The heavy work is handed to the queue, NOT done in the request. This is the
    producer/consumer decoupling: the web tier stays responsive under load.
  - Job state lives entirely in Postgres. The server keeps nothing in memory,
    so you can run N API replicas behind a load balancer and any of them can
    serve any request.
  - Uploaded files go to shared storage (a Docker volume now, S3 in prod) so the
    worker — a different process/container — can read them.

ENDPOINTS:
  POST /api/v1/analyze/upload      — file → save → enqueue
  POST /api/v1/analyze/text        — text → enqueue
  GET  /api/v1/jobs/{job_id}       — poll status + result
  GET  /api/v1/jobs/{job_id}/export— download PDF
"""
from __future__ import annotations
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.auth import decode_token, get_current_user
from api.schemas import (
    JobCreatedResponse,
    JobStatusResponse,
    TextAnalysisRequest,
)
from db.database import get_db
from db.models import Job, User
from storage import save_upload
from taskqueue import enqueue_analysis
from pipeline import run_pipeline
from output.report import generate_pdf

router = APIRouter(prefix="/api/v1")

ALLOWED_TYPES = {"application/pdf", "image/jpeg", "image/png", "image/jpg"}
MAX_BYTES = 20 * 1024 * 1024  # 20 MB


# ── DB HELPERS ────────────────────────────────────────────

async def _optional_user_id(authorization: str, db: AsyncSession) -> str | None:
    """Resolve a Bearer token to a user id, or None for guests/invalid tokens.
    Analysis stays open to guests; ownership is a bonus, never a gate."""
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        return None
    email = decode_token(token)
    if not email:
        return None
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    return user.id if user else None


async def _get_job(job_id: str, db: AsyncSession) -> Job:
    result = await db.execute(select(Job).where(Job.job_id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


async def _dispatch(
    background_tasks: BackgroundTasks,
    job_id: str,
    file_path: str | None,
    raw_text: str | None,
    source_name: str,
) -> None:
    """
    Hand the job to the worker via Redis. If the queue is unreachable, fall back
    to running it inline as a FastAPI BackgroundTask so the demo still works.
    """
    queued = await enqueue_analysis(job_id, file_path, raw_text, source_name)
    if not queued:
        background_tasks.add_task(run_pipeline, job_id, file_path, raw_text, source_name)


# ── ENDPOINTS ─────────────────────────────────────────────

@router.post("/analyze/upload", response_model=JobCreatedResponse, status_code=202)
async def analyze_upload(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    """Accept a PDF or image → save to shared storage → enqueue analysis."""
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type: {file.content_type}. Upload a PDF or image (JPG/PNG).",
        )

    content = await file.read()
    if len(content) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 20 MB limit.")

    job_id = str(uuid.uuid4())
    job = Job(
        job_id=job_id,
        status="pending",
        progress=0,
        source_name=file.filename,
        input_type="file",
        user_id=await _optional_user_id(authorization, db),
    )
    db.add(job)
    await db.commit()

    # Persist the file before processing — decouples upload from analysis.
    file_path = save_upload(job_id, file.filename or "upload.pdf", content)
    job.file_path = file_path
    await db.commit()

    await _dispatch(background_tasks, job_id, file_path, None, file.filename or "upload")

    return JobCreatedResponse(
        job_id=job_id,
        status="pending",
        message=f"Analysis started. Poll /api/v1/jobs/{job_id} for updates.",
    )


@router.post("/analyze/text", response_model=JobCreatedResponse, status_code=202)
async def analyze_text(
    background_tasks: BackgroundTasks,
    body: TextAnalysisRequest,
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    """Accept raw medical text → enqueue analysis."""
    job_id = str(uuid.uuid4())
    job = Job(
        job_id=job_id,
        status="pending",
        progress=0,
        source_name="pasted-text",
        input_type="text",
        user_id=await _optional_user_id(authorization, db),
    )
    db.add(job)
    await db.commit()

    await _dispatch(background_tasks, job_id, None, body.text, "pasted-text")

    return JobCreatedResponse(
        job_id=job_id,
        status="pending",
        message=f"Analysis started. Poll /api/v1/jobs/{job_id} for updates.",
    )


@router.get("/reports")
async def list_reports(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    The signed-in user's completed analyses, newest first.
    Returns a compact shape: enough for the history list AND the per-parameter
    trend charts (numeric values + reference ranges), without re-fetching
    every full report.
    """
    result = await db.execute(
        select(Job)
        .where(Job.user_id == user.id, Job.status == "completed")
        .order_by(Job.created_at.desc())
        .limit(50)
    )
    jobs = result.scalars().all()

    reports = []
    for j in jobs:
        r = j.result or {}
        reports.append({
            "job_id": j.job_id,
            "created_at": j.created_at.isoformat() if j.created_at else None,
            "source_name": j.source_name,
            "urgency": r.get("urgency"),
            "summary": (r.get("summary") or "")[:280],
            "findings": [
                {
                    "parameter": f.get("parameter"),
                    "value": f.get("value"),
                    "numeric_value": f.get("numeric_value"),
                    "unit": f.get("unit"),
                    "status": f.get("status"),
                    "ref_low": f.get("ref_low"),
                    "ref_high": f.get("ref_high"),
                }
                for f in (r.get("findings") or [])
            ],
        })
    return {"reports": reports}


@router.get("/jobs/{job_id}", response_model=JobStatusResponse)
async def get_job_status(job_id: str, db: AsyncSession = Depends(get_db)):
    """Poll the status and result of an analysis job."""
    job = await _get_job(job_id, db)
    return job.to_status_dict()


@router.get("/jobs/{job_id}/export")
async def export_report(job_id: str, db: AsyncSession = Depends(get_db)):
    """Generate and stream a PDF of the completed report."""
    job = await _get_job(job_id, db)

    if job.status != "completed" or not job.result:
        raise HTTPException(status_code=400, detail="Report is not ready yet.")

    pdf_path = generate_pdf(job_id, job.result)
    return FileResponse(
        path=pdf_path,
        media_type="application/pdf",
        filename=f"clearchart-report-{job_id[:8]}.pdf",
    )
