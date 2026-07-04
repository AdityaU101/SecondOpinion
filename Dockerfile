# ── ClearChart image (serves as BOTH the API and the worker) ──────────────
# One image, two commands:
#   API:    uvicorn main:app
#   Worker: arq worker.WorkerSettings
# Building once and running it two ways keeps the two processes byte-identical.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/hf-cache

# System deps: tesseract is the OCR engine pytesseract shells out to.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first for layer caching.
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install -r backend/requirements.txt

# Pre-download the embedding model so the container is self-contained and the
# first request doesn't pay a download cost (and works fully offline).
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

# App code (frontend is served by the API from ../frontend).
COPY backend ./backend
COPY frontend ./frontend

WORKDIR /app/backend
EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
