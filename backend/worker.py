"""
The background worker (the "consumer" side of Phase 6 decoupling).

Run it with:
    arq worker.WorkerSettings

It is the SAME Docker image as the API, just a different command. On startup it
builds the RAG index (so retrieval is warm) and ensures shared storage exists.
Each queued job runs `analyze_job`, which delegates to the shared pipeline.

Scale it horizontally by running more `worker` replicas — no code change.
"""
from __future__ import annotations
import logging

from config import settings
from taskqueue import redis_settings

logging.basicConfig(level=settings.log_level)
log = logging.getLogger("worker")


async def analyze_job(ctx, job_id, file_path, raw_text, source_name):
    """Queue task: run the full analysis pipeline for one job."""
    from pipeline import run_pipeline

    log.info("Picked up job %s (source=%s)", job_id, source_name)
    await run_pipeline(job_id, file_path, raw_text, source_name)
    return {"job_id": job_id, "status": "done"}


async def startup(ctx):
    """Warm the process: DB tables, upload dir, and the RAG index."""
    from db.database import create_tables
    from storage import ensure_upload_dir
    from rag.retriever import build_index

    await create_tables()
    ensure_upload_dir()
    await build_index()
    log.info("Worker ready — waiting for jobs")


async def shutdown(ctx):
    log.info("Worker shutting down")


class WorkerSettings:
    """arq discovers this class. `arq worker.WorkerSettings` runs it."""
    functions = [analyze_job]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = redis_settings()
    max_jobs = 4            # concurrent jobs per worker process
    job_timeout = 300       # seconds — generous for OCR + LLM
