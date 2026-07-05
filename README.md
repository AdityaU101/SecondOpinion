# ClearChart — Medical Document "Second Opinion" Analyzer

ClearChart turns a confusing lab report or discharge summary into a plain-English
explanation: what each value means, which ones are outside normal range, which
everyday foods support the values that are off, and a short list of questions to
bring to your doctor — every claim grounded in cited clinical guidelines.

It has grown into a small end-to-end SaaS: landing page → login (or guest mode) →
analysis app with report history, longitudinal trends, family profiles, a
medication-interaction review, an in-app assistant, and printable appointment
prep sheets.

> **It is a health-literacy tool, not a diagnostic tool.** Every surface carries a
> disclaimer and the system is explicitly prompted never to diagnose or prescribe.

---

## Features

| Area | What it does |
|---|---|
| **Document analysis** | Upload PDF/JPG/PNG or paste text → plain-English report with urgency level, per-value "healthy range vs you" charts, wellness score per body system, doctor questions, and guideline citations (NIH/WHO/USPSTF). |
| **Nutrition guidance** | Deficient or elevated values map to everyday foods that support them (iron-rich foods for low hemoglobin, soluble fibre for high LDL, …) via a deterministic rule table — no LLM guessing. |
| **Interactive terms** | Medical terms in reports (ferritin, eGFR, neutrophils, …) open popovers with plain-English explanations: what it is, why it matters, high vs low, common causes, what patients discuss next. |
| **History + timeline** | Completed reports are saved per profile. Recurring biomarkers are charted over time — sparkline, % change, direction, healthy range — plus grounded trend sentences built only from real report values. |
| **Family profiles** | One account, many profiles ("Me", "Mother", "Child"…). Reports, trends, medications, chat context, and prep sheets are all profile-scoped. |
| **Medication review** | Enter medications (type-ahead via NIH RxNav). ClearChart retrieves each drug's official FDA label live (openFDA/DailyMed) and shows *label-documented* interactions, food/alcohol warnings, side effects, timing, and monitoring — every statement cited. No label → it says so; nothing is invented. |
| **Assistant chatbot** | In-app Groq-powered assistant that answers health-literacy questions with the current report as context. Hard rules: no diagnosis, no dosing, urgent symptoms → see a doctor. |
| **Appointment prep** | One click turns a report into a printable sheet: top findings, question checklist, note lines. |
| **Auth + guest mode** | Email/password accounts (PBKDF2 hashing, stateless HMAC-signed tokens) or a zero-friction guest mode where everything stays in localStorage. |
| **UI** | "ECG chart paper" design system — Bricolage Grotesque / Inter / IBM Plex Mono, full dark mode, fast orchestrated animations, `prefers-reduced-motion` respected. Vanilla HTML/CSS/JS, no framework. |

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
                                             │ users/profiles│
                                             │ jobs/meds    │
                                             └──────────────┘
            uploaded files ──► shared volume (S3 in prod) ◄── worker reads them
```

**The web tier holds no state.** Job status, users, profiles, and medication lists
live in Postgres (Neon in the demo deployment; SQLite locally); uploaded files live
in shared storage; sessions are HMAC-signed tokens validated with nothing but the
shared secret. So you can run N API replicas behind a load balancer and any replica
can serve any request — and a crash loses nothing.

**Producer/consumer decoupling.** Analysis takes ~10–30s (OCR + embeddings + LLM).
The API never does that work inline — it drops a job on Redis and returns instantly.
Workers drain the queue; if the backlog grows, add more workers without touching
the API. (No Redis locally? The API detects it and falls back to inline
BackgroundTasks so the demo still works.)

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
3. **LLM synthesis (`analysis/synthesizer.py`)** — **Groq (Llama 3.3 70B)** receives
   the verified findings as *ground truth* plus the retrieved guideline passages as
   context, and writes the plain-English summary + doctor questions. It returns data
   via a **forced function call**, which guarantees valid structured JSON.

If `GROQ_API_KEY` is unset or the API errors, the system returns a deterministic
**rule-only** report. It degrades; it never hard-fails.

The same retrieval-first philosophy applies to the **medication review**
(`api/medications.py`): drug facts are fetched live from openFDA labels and NIH
RxNav at request time; the LLM is only allowed to *rephrase* the retrieved
excerpts, and the verbatim excerpts + citation links are always shown alongside.

---

## Run it

### Docker (recommended — full stack)

```bash
cp backend/.env.example .env      # then set GROQ_API_KEY in .env
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
export GROQ_API_KEY=gsk_...
export SECRET_KEY=change-me-in-prod                  # signs auth tokens
uvicorn main:app --reload                            # terminal 1
arq worker.WorkerSettings                            # terminal 2 (optional w/ Redis)
```

The API serves the frontend at `http://localhost:8000` (landing → `login.html` →
`app.html`). "Explore as a guest" works with no account and keeps all data on-device.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/analyze/upload` | Upload a PDF/JPG/PNG → `202` + `job_id` (optional `Authorization` + `X-Profile-Id`) |
| `POST` | `/api/v1/analyze/text` | Submit raw text → `202` + `job_id` |
| `GET` | `/api/v1/jobs/{job_id}` | Poll status, progress, and the nested result |
| `GET` | `/api/v1/jobs/{job_id}/export` | Download the report as PDF |
| `GET` | `/api/v1/reports?profile_id=` | 🔒 Completed reports for one profile (compact shape for history + trends) |
| `POST` | `/api/v1/auth/register` · `/login` | Create account / sign in → signed token |
| `GET` | `/api/v1/auth/me` | 🔒 Validate token, refresh display info |
| `GET/POST/PATCH/DELETE` | `/api/v1/profiles[...]` | 🔒 Family profiles (default profile auto-created) |
| `GET/POST/DELETE` | `/api/v1/medications[...]` | 🔒 Per-profile medication list |
| `GET` | `/api/v1/medications/search?q=` | Name suggestions via NIH RxNav |
| `POST` | `/api/v1/medications/analyze` | Stateless label analysis via openFDA (open to guests) |
| `POST` | `/api/v1/chat` | Assistant reply grounded in optional report context |
| `GET` | `/health` · `/docs` | Liveness check · interactive OpenAPI docs |

🔒 = requires `Authorization: Bearer <token>`.

Poll response (nested JSON):

```json
{
  "job_id": "550e8400-...",
  "status": "completed",
  "progress": 100,
  "result": {
    "urgency": "watch",
    "summary": "...",
    "findings": [{ "parameter": "LDL Cholesterol", "value": "145 mg/dL", "status": "high", "severity": "moderate", "numeric_value": 145, "ref_low": 0, "ref_high": 100, "unit": "mg/dL", "explanation": "..." }],
    "questions_for_doctor": [{ "question": "...", "context": "...", "citation": "..." }],
    "citations": [{ "source": "USPSTF — Statin Use ...", "passage": "...", "url": "..." }],
    "health_snapshot": [{ "area": "Heart & vessels", "score": 62, "status": "watch", "note": "..." }],
    "confidence_score": 0.82,
    "disclaimer": "..."
  },
  "error": null
}
```

---

## Project structure

```
.
├── docker-compose.yml      # db + redis + api + worker
├── Dockerfile              # one image, run as api OR worker
├── backend/
│   ├── main.py             # FastAPI app + lifespan (tables, RAG index, queue pool)
│   ├── config.py           # typed settings from env (12-factor)
│   ├── taskqueue.py        # PRODUCER: enqueue to Redis (arq)
│   ├── worker.py           # CONSUMER: arq worker entrypoint
│   ├── pipeline.py         # shared extract → detect → synthesize
│   ├── storage.py          # shared file storage (S3-swappable)
│   ├── api/
│   │   ├── routes.py       # analyze / jobs / reports
│   │   ├── auth.py         # register / login (PBKDF2 + HMAC tokens)
│   │   ├── profiles.py     # family profiles CRUD
│   │   ├── medications.py  # RxNav search + openFDA label retrieval/analysis
│   │   ├── chat.py         # report-aware assistant
│   │   └── schemas.py      # pydantic shapes shared by all layers
│   ├── db/                 # async SQLAlchemy engine, models, additive migrations
│   ├── ingestion/parser.py # PDF/OCR text extraction
│   ├── analysis/           # anomaly rule engine + Groq synthesizer
│   ├── rag/retriever.py    # hybrid BM25 + FAISS retrieval
│   ├── output/report.py    # PDF export (fpdf2)
│   └── kb/guidelines.json  # clinical-guideline knowledge base
└── frontend/               # static UI, served by the API (no framework)
    ├── index.html          # landing page
    ├── login.html          # sign in / sign up / guest mode
    ├── app.html            # the analysis app (upload → processing → report,
    │                       #   history & trends, medication review, prep sheet)
    ├── app.js              # app logic: profiles, trends, meds, chat, glossary
    ├── site.js             # shared: theme toggle + session helpers
    └── styles.css          # token-driven design system, light + dark
```

---

## Interview talking points (the "why")

- **Why a queue instead of `async`/BackgroundTasks?** BackgroundTasks run *inside*
  the API process — a burst of uploads competes with request handling and dies with
  the process. A real queue decouples producer from consumer so they scale and fail
  independently.
- **Why stateless + Postgres + shared volume?** It's what lets you horizontally
  scale the web tier and survive crashes — any replica/worker can pick up any job.
  Auth follows the same principle: HMAC-signed tokens mean no session table.
- **Why rules AND an LLM?** Numbers come from a deterministic engine (LLMs miscompute
  boundaries); language comes from the LLM. This is the line between a toy
  "just ask GPT" prototype and a trustworthy system. The same split repeats in the
  trend summaries (rule-generated from real values) and the medication review
  (live label retrieval; LLM restricted to rephrasing excerpts).
- **Why forced function calling for output?** The model *must* return data in our
  shape, eliminating brittle text parsing.
- **Why hybrid BM25 + FAISS?** Medical text is full of exact codes BM25 matches
  perfectly, plus fuzzy phrasing that needs semantic vectors. RRF fuses both.
- **Why local embeddings?** No API key, no per-call cost, runs offline — and it keeps
  potential PHI from leaving the box, which matters for health data.
- **Why profile_id NULL = default profile?** An additive migration plus a read-time
  convention upgrades existing accounts to family profiles with zero data rewrites
  and zero breaking changes.
- **How would this go to real production?** Swap the shared volume for S3 +
  presigned URLs, add Alembic migrations, rate limiting, per-user encryption at rest,
  move the guideline KB to a managed vector DB (pgvector/Pinecone) for multi-tenancy,
  and add observability (structured logs + traces) around the pipeline stages.
