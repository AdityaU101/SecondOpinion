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
| **"Since last report" strip** | Every reopened or new report automatically shows what changed versus the profile's previous report — improvement/worsening/new-abnormality chips computed by the same deterministic diff engine as Comparison Mode. No LLM call, nothing stored, one indexed query; first-ever reports get a friendly "upload another report to track changes" note. |
| **Follow-up Tracker** | Each report generates guideline-backed follow-up items ("Repeat HbA1c in ~3 months", "Ask about kidney function changes") from a fixed rule table over the rule engine's findings — values without a matching rule get nothing, never an invented suggestion. Items carry priority (from severity), reason, and a citation (reusing the report's own retrieved citations where they match). Checkboxes and personal notes persist server-side; state changes are tiny PATCHes that never re-run generation or the LLM. |
| **Explain This Value** | Every lab value in a report is clickable and opens a drawer (bottom sheet on mobile): what it measures, why clinicians watch it, high-vs-low, common causes, your value charted against the healthy range, related biomarkers, which of *your* listed medications are commonly linked to it, and guideline citations from the RAG index. Assembled entirely from existing data — glossary, findings, med list, retriever — with honest "not available" states and zero LLM involvement. |
| **Report Comparison Mode** | Pick any two saved reports on the History page and see a computed diff: new abnormalities, resolved values, improved / worsened / unchanged biomarkers, plus values measured only in one report ("measured for the first time" / "not re-measured — unresolved"). Every classification is deterministic backend code over stored findings; the LLM only rewrites the finished diff into a plain-English summary. Comparisons are saved per report pair, so repeating one is a single indexed lookup. |
| **Doctor Visit Packet** | A fuller, saved companion to the prep sheet: one click on any report (current or from history) assembles an appointment-ready packet — opening note, high-priority values, wellness scores, trend sentences from prior reports, the profile's medication list, doctor questions, a follow-up checklist, citations, and a physician-notes box. Print or download as PDF; the packet is stored with the report so reopening it never re-runs analysis or the LLM. |
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

**Multi-provider LLM fallback (`llm.py`).** Every LLM feature (synthesis, chat,
medication gloss, visit-packet note, comparison summary) calls one shared
`chat_completion()` instead of constructing its own client. It walks an ordered
provider chain — **Groq** primary, **OpenRouter** fallback (same Llama 3.3 70B
family, so tone and function-calling behavior stay consistent) — and retries
transparently when a provider is rate-limited or down. Because both speak the
OpenAI chat-completions dialect, a "provider" is just a `(base_url, api_key,
model)` triple handed to the same client, and responses parse identically no
matter who answered. Only when the whole chain fails does the error reach the
caller — and every caller already degrades deterministically, so:

If no provider key is set, or the entire chain errors, the system returns a
deterministic **rule-only** report. It degrades; it never hard-fails.

The same retrieval-first philosophy applies to the **medication review**
(`api/medications.py`): drug facts are fetched live from openFDA labels and NIH
RxNav at request time; the LLM is only allowed to *rephrase* the retrieved
excerpts, and the verbatim excerpts + citation links are always shown alongside.

And the **Doctor Visit Packet** (`api/packets.py` + `output/packet.py`) reuses
outputs the pipeline already produced instead of re-running anything: the job's
stored report supplies the flagged values, wellness scores, questions, and
citations; prior completed reports for the same profile become deterministic
trend sentences; the medication table supplies the med list; and a rule-derived
follow-up checklist rounds it out. One optional LLM call rewrites those
already-determined facts into a short patient-friendly opening note — if Groq is
unavailable, a deterministic note is used and the packet still ships whole. The
result is saved (`visit_packets`, one row per job, additive migration-free
table) so reopening a packet later costs zero LLM calls.

**Report Comparison Mode** (`api/comparisons.py` + `analysis/compare.py`)
follows the same discipline one step further. The diff between two reports is
pure backend code over the findings the rule engine already validated:

- present in both → `new_abnormalities` / `resolved` by status change, or
  `improved` / `worsened` / `unchanged` for values flagged in both, decided by
  the value's **distance from the healthy range** (closer = improved; a
  relative change under 3% counts as unchanged);
- present in one report only → labelled exactly that (`newly_measured`, or
  `not_remeasured` with an "unresolved" note if it was flagged) — never
  interpolated or guessed.

The LLM's only job is rewriting the finished buckets into a 3–5 sentence
summary; without a key, a deterministic summary is built from the same counts.
Pairs are normalised (older, newer) and the result stored in
`report_comparisons` with a unique constraint on the pair — re-comparing is one
indexed lookup and never re-runs the diff or the LLM.

Three smaller features ride on the same rails:

- **"Since last report"** (`POST /jobs/{id}/changes`) reuses the comparison
  engine's diff against the profile's most recent prior report and flattens it
  into ordered change records. It runs on every report open, so it is
  deliberately LLM-free and storage-free — template wording, pure dict math.
- **Follow-up Tracker** (`analysis/recommendations.py` + `api/recommendations.py`)
  maps rule-validated abnormal findings through a fixed rule table to
  guideline-backed follow-up items; priority comes from the rule engine's
  severity, citations prefer the report's own retrieved passages (keyword
  match) with a static guideline reference as fallback. Items are generated
  once, persisted in the additive `recommendations` table, and then owned by
  the user: completion timestamps and notes are plain row updates. The one
  optional LLM pass may only rewrite the `reason` strings and is strictly
  validated (same count, sane lengths) or discarded.
- **Explain This Value** (`api/explain.py`) is almost entirely frontend
  assembly of data the app already has — the curated glossary, the finding
  itself, the medication list — plus one backend route that reuses the RAG
  retriever for citations. No LLM: the drawer must be instant, and everything
  in it is curated, rule-validated, or retrieved verbatim with its source.

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
| `POST` | `/api/v1/jobs/{job_id}/packet` | Build (or return the saved) Doctor Visit Packet — guests pass their local profile/meds/history in the body |
| `GET` | `/api/v1/jobs/{job_id}/packet` | Reopen a previously generated packet |
| `GET` | `/api/v1/jobs/{job_id}/packet/export` | Download the packet as PDF |
| `POST` | `/api/v1/reports/compare` | Deterministic diff of two completed reports (`{left_job_id, right_job_id}`); saved per pair |
| `POST` | `/api/v1/jobs/{job_id}/changes` | "Since last report" change records vs the profile's previous report (no LLM, not stored) |
| `POST` | `/api/v1/jobs/{job_id}/recommendations` | Generate-or-return the report's follow-up items |
| `PATCH` | `/api/v1/recommendations/{rec_id}` | Toggle completion / edit the personal note |
| `GET` | `/api/v1/recommendations/pending` | Open follow-ups (`?profile_id=` signed-in, `?job_ids=` guests) |
| `GET` | `/api/v1/explain?q=` | Guideline citations for one biomarker via the RAG index |
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
│   ├── llm.py              # multi-provider LLM chain (Groq → OpenRouter fallback)
│   ├── taskqueue.py        # PRODUCER: enqueue to Redis (arq)
│   ├── worker.py           # CONSUMER: arq worker entrypoint
│   ├── pipeline.py         # shared extract → detect → synthesize
│   ├── storage.py          # shared file storage (S3-swappable)
│   ├── api/
│   │   ├── routes.py       # analyze / jobs / reports
│   │   ├── auth.py         # register / login (PBKDF2 + HMAC tokens)
│   │   ├── profiles.py     # family profiles CRUD
│   │   ├── medications.py  # RxNav search + openFDA label retrieval/analysis
│   │   ├── packets.py      # Doctor Visit Packet endpoints (build / reopen / PDF)
│   │   ├── comparisons.py  # Report Comparison Mode + "since last report" endpoints
│   │   ├── recommendations.py # Follow-up Tracker endpoints (generate / toggle / pending)
│   │   ├── explain.py      # "Explain This Value" citation lookup
│   │   ├── chat.py         # report-aware assistant
│   │   └── schemas.py      # pydantic shapes shared by all layers
│   ├── db/                 # async SQLAlchemy engine, models, additive migrations
│   ├── ingestion/parser.py # PDF/OCR text extraction
│   ├── analysis/           # anomaly rule engine + synthesizer + report diff + follow-up rules
│   ├── rag/retriever.py    # hybrid BM25 + FAISS retrieval
│   ├── output/report.py    # PDF export (fpdf2) — report + visit packet
│   ├── output/packet.py    # Doctor Visit Packet assembly (deterministic + LLM note)
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
- **Why does the Follow-up Tracker use a rule table instead of asking the LLM
  for advice?** "What should the patient do next" is exactly where hallucination
  is most dangerous. A fixed table of guideline-backed actions keyed on the rule
  engine's findings means every item is traceable to a citation, values without
  a rule get *nothing*, and the output is testable. The LLM may only reword the
  reason strings, and its output is validated against the deterministic version
  (same count or discarded). State changes are row updates — one LLM call per
  report maximum, ever.
- **Why is "Explain This Value" LLM-free?** It opens on a click, so it must be
  instant; and everything it shows is already curated (glossary), validated
  (the finding), or retrieved with a source (citations). An LLM could only add
  latency and risk. This is the "retrieval-first" argument in its purest form.
- **Why a provider chain instead of retrying the same API?** Retrying a
  rate-limited provider just waits out the limit; falling back to a second
  provider serves the request *now*. Free tiers rate-limit per account, so two
  providers roughly double burst capacity for free. The chain lives behind one
  function, so features don't know or care who answered — and the deterministic
  fallbacks remain the final tier, which is why adding providers never added a
  new failure mode.
- **Why is the report comparison deterministic instead of "ask the LLM what
  changed"?** Comparing 160 → 145 against a reference range is arithmetic, and
  LLMs are unreliable at exactly that. Code computes every classification
  (including the honest "not re-measured" bucket for one-sided values — no
  interpolation), so the output is reproducible, testable, and safe; the LLM is
  reduced to a stylist that rewrites finished facts. It's the same rules-decide/
  model-narrates split as the analysis pipeline, applied to a second feature.
- **Why is the Visit Packet assembled, not re-analyzed?** The report, trends, and
  medication list already exist — regenerating them would cost latency, LLM tokens,
  and (worse) could produce a packet that disagrees with the report it accompanies.
  Reading stored outputs guarantees consistency for free. Saving the packet with
  the job makes reopening idempotent: at most one LLM call per packet, ever.
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
