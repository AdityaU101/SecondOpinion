"""
The analysis pipeline — the single source of truth for "what happens to a job".

This used to live inside the FastAPI route as a BackgroundTask. It now lives
here so BOTH callers can share it:
  - the arq worker (the normal, decoupled path), and
  - an inline fallback in the API (used only if Redis is unreachable).

Pipeline stages (each updates the job's `progress` so the UI can show a bar):
  1. extract   — pull text from the uploaded PDF/image (or use pasted text)
  2. detect    — rule engine flags lab values outside reference ranges
  3. synthesize— Claude turns verified findings + RAG context into a report

Notice what is NOT here: no in-memory state. Every stage reads/writes the
`jobs` table. Any worker (or API instance) can run any job — that is the
"stateless tier + shared storage" principle from the checklist.
"""
from __future__ import annotations
import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

log = logging.getLogger(__name__)


async def _update_job(db, job_id: str, **fields) -> None:
    """Patch a job row and commit. Uses whatever AsyncSession is passed in."""
    from db.models import Job

    result = await db.execute(select(Job).where(Job.job_id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        log.warning("update_job: job %s not found", job_id)
        return
    for key, value in fields.items():
        setattr(job, key, value)
    job.updated_at = datetime.now(timezone.utc)
    await db.commit()


async def run_pipeline(
    job_id: str,
    file_path: str | None,
    raw_text: str | None,
    source_name: str,
) -> None:
    """Execute the full analysis and persist the result to the DB."""
    from db.database import AsyncSessionLocal
    from storage import load_upload
    from ingestion.parser import extract_text
    from analysis.anomaly import detect_anomalies
    from analysis.synthesizer import synthesize_report

    async with AsyncSessionLocal() as db:
        try:
            # ── 1. Extract ────────────────────────────────
            await _update_job(db, job_id, status="processing", progress=15)

            if file_path and not raw_text:
                content = load_upload(file_path)
                # OCR/PDF parsing is CPU-bound → run off the event loop
                raw_text = await asyncio.to_thread(
                    extract_text, content, Path(file_path).name
                )

            if not raw_text or len(raw_text.strip()) < 30:
                raise ValueError("Could not extract readable text from the document.")

            # ── 2. Rule-based anomaly detection ───────────
            await _update_job(db, job_id, progress=45)
            anomalies = await asyncio.to_thread(detect_anomalies, raw_text)

            # ── 3. LLM synthesis (RAG retrieval inside) ───
            await _update_job(db, job_id, progress=70)
            report = await synthesize_report(
                raw_text=raw_text,
                rule_anomalies=anomalies,
            )

            # ── Done ──────────────────────────────────────
            await _update_job(
                db, job_id,
                status="completed",
                progress=100,
                result=report.model_dump(mode="json"),
                completed_at=datetime.now(timezone.utc),
            )
            log.info("Job %s completed", job_id)

        except Exception as exc:  # noqa: BLE001 — we want to record any failure
            log.exception("Job %s failed", job_id)
            await _update_job(db, job_id, status="failed", error=str(exc))
            raise
