"""
ClearChart — FastAPI entry point
Run with: uvicorn main:app --reload
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from api.routes import router
from api.auth import router as auth_router
from api.chat import router as chat_router
from api.profiles import router as profiles_router
from api.medications import router as medications_router
from config import settings
from db.database import create_tables
from storage import ensure_upload_dir
from taskqueue import init_pool, close_pool
from rag.retriever import build_index


# ── LIFESPAN ─────────────────────────────────────────────
# FastAPI's lifespan replaces the old @app.on_event("startup") pattern.
# Everything here runs BEFORE the first request is accepted.
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Create DB tables (idempotent — safe to run every time)
    await create_tables()

    # 2. Ensure shared upload storage exists
    ensure_upload_dir()

    # 3. Build the RAG retrieval index (BM25 is pure-Python and cheap; the
    #    heavy FAISS/vector layer only builds when EMBEDDING_BACKEND=local).
    #    This makes retrieval/citations work even in local inline mode where no
    #    separate worker is running.
    await build_index()

    # 4. Connect to the Redis queue (producer side). If Redis isn't running
    #    (local dev), this falls back to inline processing in ~1s.
    await init_pool()

    print("ClearChart API is ready - http://localhost:8000")
    yield

    await close_pool()


# ── APP ───────────────────────────────────────────────────
app = FastAPI(
    title="ClearChart API",
    description="AI-powered medical record literacy platform",
    version="0.2.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────
# Lock this down to your real domain in production.
_origins = [o.strip() for o in settings.cors_origins.split(",")] if settings.cors_origins else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── API ROUTES ────────────────────────────────────────────
app.include_router(router)
app.include_router(auth_router)
app.include_router(chat_router)
app.include_router(profiles_router)
app.include_router(medications_router)

# ── SERVE FRONTEND ────────────────────────────────────────
# Open http://localhost:8000 → serves the UI directly.
# No separate dev server needed.
frontend_dir = Path(__file__).parent.parent / "frontend"

if frontend_dir.exists():
    app.mount("/static", StaticFiles(directory=str(frontend_dir)), name="static")

    @app.get("/", include_in_schema=False)
    async def serve_frontend():
        return FileResponse(str(frontend_dir / "index.html"))

    @app.get("/styles.css", include_in_schema=False)
    async def serve_css():
        return FileResponse(str(frontend_dir / "styles.css"), media_type="text/css")

    @app.get("/app.js", include_in_schema=False)
    async def serve_js():
        return FileResponse(str(frontend_dir / "app.js"), media_type="application/javascript")

    @app.get("/site.js", include_in_schema=False)
    async def serve_site_js():
        return FileResponse(str(frontend_dir / "site.js"), media_type="application/javascript")

    @app.get("/app.html", include_in_schema=False)
    async def serve_app_page():
        return FileResponse(str(frontend_dir / "app.html"))

    @app.get("/login.html", include_in_schema=False)
    async def serve_login_page():
        return FileResponse(str(frontend_dir / "login.html"))

    @app.get("/index.html", include_in_schema=False)
    async def serve_index_page():
        return FileResponse(str(frontend_dir / "index.html"))


# ── HEALTH CHECK ──────────────────────────────────────────
@app.get("/health", tags=["meta"])
async def health():
    return {"status": "ok", "service": "clearchart", "version": "0.2.0"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
