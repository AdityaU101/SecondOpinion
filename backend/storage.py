"""
Local file storage for uploaded medical documents.

WHY SAVE TO DISK (not just pass bytes around)?
  The upload HTTP request completes in ~milliseconds.
  The processing pipeline takes 10–30 seconds.
  If we only kept the file in memory attached to the request,
  it would be gone before processing even starts.

  Saving to disk decouples upload from processing — a key
  stateless design principle. In production you'd replace
  this with S3 (boto3 + presigned URLs), which also survives
  server crashes. The rest of the code doesn't change.

DIRECTORY LAYOUT:
  uploads/
    {job_id}/
      original.{ext}    ← the raw uploaded file
"""
from __future__ import annotations
import os
from pathlib import Path

# Configurable via env var; defaults to ./uploads next to main.py
_UPLOAD_ROOT = Path(os.getenv("UPLOAD_DIR", "./uploads")).resolve()


def save_upload(job_id: str, filename: str, content: bytes) -> str:
    """
    Persist uploaded bytes to disk.
    Returns the absolute path to the saved file.
    """
    job_dir = _UPLOAD_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    ext = Path(filename).suffix.lower() or ".bin"
    dest = job_dir / f"original{ext}"
    dest.write_bytes(content)
    return str(dest)


def load_upload(file_path: str) -> bytes:
    """Read a previously saved upload back into memory."""
    return Path(file_path).read_bytes()


def delete_upload(job_id: str) -> None:
    """
    Remove all files for a job (call after processing is complete
    if you want a privacy-first, no-PHI-at-rest design).
    """
    import shutil
    job_dir = _UPLOAD_ROOT / job_id
    if job_dir.exists():
        shutil.rmtree(job_dir)


def ensure_upload_dir() -> None:
    """Create the upload root if it doesn't exist (called at startup)."""
    _UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
