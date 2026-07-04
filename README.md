# ClearChart — Medical Document "Second Opinion" Analyzer

ClearChart turns a confusing lab report or discharge summary into a plain-English
explanation: what each value means, which ones are outside normal range, and a
short list of questions to bring to your doctor — every claim grounded in cited
clinical guidelines.

> **It is a health-literacy tool, not a diagnostic tool.** Every report carries a
> disclaimer and the system is explicitly prompted never to diagnose or prescribe.

---

## Why the architecture looks the way it does

This project follows the *"Scale from Zero"* method from *System Design Interview*
(Alex Xu): start on one host, then make the web tier **stateless** and **decouple**
slow work behind a queue so each tier scales independently.

```
                ┌──────────────┐
   Browser ───► │   FastAPI    │  (api)  ── PRODUCER
   (frontend)   │  web tier    │
                └──────┬───────┘
        202 Accepted   │ enqueue(job_id)
        + job_id       ▼
                ┌──────────────┐        ┌──────────────┐
                │    Redis     │ ◄────► │   arq worker │  (worker) ── CONSUMER
                │ message queue│        │  pipeline    │
                └──────────────┘        └──────┬───────┘
                                                │
   poll GET /jobs/{id} ◄── shared state ──►  ┌──┴───────────┐
                                             │  PostgreSQL  │  (db)
                                             │  jobs table  │
                                             └──────────────┘
            uploaded files ──► shared volume (S3 in prod) ◄── worker reads them
```

**The web tier holds no state.** Job status lives in Postgres; uploaded files live
in shared storage. So you can run N API replicas behind a load balancer and any
replica can serve any request — and a crash loses nothing.

**Producer/consumer decoupling.** Analysis takes ~10–30s (OCR + embeddings + LLM).
The API never does that work inline — it drops a job on Redis and returns instantly.
Workers drain the queue; if the backlog grows, add more workers without touching
the API.

---

## The analysis pipeline (what the worker does)

A deliberate **two-layer design** — this is the most important design point:

1. **Rule engine (`analysis/anomaly.py`)** — deterministic. Regex-extracts lab
   values and checks them against a reference-range table. LLMs are unreliable at
   arithmetic and boundary checks, so *numbers* are decided by rules, never the model.
2. **RAG retrieval (`rag/retriever.py`)** — hybrid **BM25 + FAISS** search over a
   clinical-guideline knowledge base. BM25 nails exact medical codes (`eGFR`,
   `HbA1c`); vector search handles fuzzy/semantic queries; results are merged with
   Reciprocal Rank Fusion.
3. **LLM synthesis (`analysis/synthesizer.py`)** — **Claude** receives the verified
   findings as *ground truth* plus the retrieved guideline passages as context, and
   writes the plain-English summary + doctor questions. It returns data via a
   **forced tool call**, which guarantees valid structured JSON.

If `ANTHROPIC_API_KEY` is unset or the API errors, the system returns a deterministic
**rule-only** report. It degrades; it never hard-fails.

---

## Run it

### Docker (recommended — full stack)

```bash
cp backend/.env.example .env      # then set ANTHROPIC_API_KEY in .env
docker compose up --build
# open http://localhost:8000
```

This starts **postgres + redis + api + worker**. The embedding model is baked into
the image, so it works offline after the build. Without an API key the stack still
comes up and returns rule-only reports.

### Local (no Docker)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# leave DATABASE_URL unset to use SQLite; if no Redis, the API runs jobs inline
export ANTHROPIC_API_KEY=sk-ant-...
uvicorn main:app --reload                            # terminal 1
arq worker.WorkerSettings                            # terminal 2 (optional w/ Redis)
```

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/analyze/upload` | Upload a PDF/JPG/PNG → `202` + `job_id` |
| `POST` | `/api/v1/analyze/text` | Submit raw text → `202` + `job_id` |
| `GET` | `/api/v1/jobs/{job_id}` | Poll status, progress, and the nested result |
| `GET` | `/api/v1/jobs/{job_id}/export` | Download the report as PDF |
| `GET` | `/health` | Liveness check |
| `GET` | `/docs` | Interactive OpenAPI docs |

Poll response (nested JSON, per checklist Phase 5):

```json
{
  "job_id": "550e8400-...",
  "status": "completed",
  "progress": 100,
  "result": {
    "urgency": "watch",
    "summary": "...",
    "findings": [{ "parameter": "LDL Cholesterol", "value": "145 mg/dL (high)", "status": "high", "severity": "moderate", "explanation": "..." }],
    "questions_for_doctor": [{ "question": "...", "context": "...", "citation": "..." }],
    "citations": [{ "source": "USPSTF — Statin Use ...", "passage": "...", "url": "..." }],
    "confidence_score": 0.82,
    "disclaimer": "..."
  },
  "error": null
}
```

---

## Checklist → implementation map

| Step | Checklist task | Where it lives |
|---|---|---|
| S1 | Single web tier | `main.py`, `api/routes.py`, `Dockerfile` |
| S2 | RDBMS, structured `jobs` | `db/models.py`, `db/init.sql`, Postgres service |
| S3 | Stateless tier + shared storage | DB-backed state, `storage.py` + shared volume |
| S4 | Vector store / RAG | `rag/retriever.py` (FAISS + BM25), `kb/guidelines.json` |
| S5 | Nested JSON API | `api/routes.py`, `api/schemas.py` |
| S6 | Message queue + worker | `taskqueue.py` (producer), `worker.py` (consumer), Redis |

---

## Project structure

```
.
├── docker-compose.yml      # db + redis + api + worker
├── Dockerfile              # one image, run as api OR worker
├── backend/
│   ├── main.py             # FastAPI app + lifespan (creates queue pool)
│   ├── config.py           # typed settings from env (12-factor)
│   ├── taskqueue.py        # PRODUCER: enqueue to Redis (arq)
│   ├── worker.py           # CONSUMER: arq worker entrypoint
│   ├── pipeline.py         # shared extract → detect → synthesize
│   ├── storage.py          # shared file storage (S3-swappable)
│   ├── api/                # routes + pydantic schemas
│   ├── db/                 # async SQLAlchemy engine, Job model, init.sql
│   ├── ingestion/parser.py # PDF/OCR text extraction
│   ├── analysis/           # anomaly rule engine + Claude synthesizer
│   ├── rag/retriever.py    # hybrid BM25 + FAISS retrieval
│   ├── output/report.py    # PDF export (fpdf2)
│   └── kb/guidelines.json  # clinical-guideline knowledge base
└── frontend/               # static UI, served by the API
```

---

## Interview talking points (the "why")

- **Why a queue instead of `async`/BackgroundTasks?** BackgroundTasks run *inside*
  the API process — a burst of uploads competes with request handling and dies with
  the process. A real queue decouples producer from consumer so they scale and fail
  independently. *(Phase 6.)*
- **Why stateless + Postgres + shared volume?** It's what lets you horizontally
  scale the web tier and survive crashes — any replica/worker can pick up any job.
  *(Phase 3.)*
- **Why rules AND an LLM?** Numbers come from a deterministic engine (LLMs miscompute
  boundaries); language comes from the LLM. This is the line between a toy
  "just ask GPT" prototype and a trustworthy system.
- **Why forced tool use for output?** It's Claude's equivalent of strict JSON-schema
  output: the model *must* return data in our shape, eliminating brittle text parsing.
- **Why hybrid BM25 + FAISS?** Medical text is full of exact codes BM25 matches
  perfectly, plus fuzzy phrasing that needs semantic vectors. RRF fuses both.
- **Why local embeddings?** No API key, no per-call cost, runs offline — and it keeps
  potential PHI from leaving the box, which matters for health data.
- **How would this go to real production?** Swap the shared volume for S3 +
  presigned URLs, add Alembic migrations, put auth + rate limiting on the API, move
  the guideline KB to a managed vector DB (pgvector/Pinecone) for multi-tenancy, and
  add observability (structured logs + traces) around the pipeline stages.
```
