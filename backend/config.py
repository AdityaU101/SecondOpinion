"""
Centralised application settings.

WHY A SETTINGS OBJECT (instead of os.getenv scattered everywhere)?
  - One typed, documented place that lists every knob the system has.
  - Values come from environment variables (12-factor config), with sane
    defaults so the app boots even with an empty .env.
  - The same image runs as the API *and* the worker; both read this file,
    so they can never drift out of sync on, e.g., which DB or Redis to use.

Anything secret (API keys) has NO default — it must be supplied via env.
"""
from __future__ import annotations
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ── LLM (Groq) ────────────────────────────────────────
    groq_api_key: str = ""                            # required for real analysis
    llm_model: str = "llama-3.3-70b-versatile"        # Groq synthesis model
    llm_max_tokens: int = 3000
    llm_temperature: float = 0.3                      # low-ish = factual but descriptive

    # ── Embeddings (local sentence-transformers) ──────────
    # "local"  → all-MiniLM-L6-v2 vectors feed the FAISS index (hybrid RAG)
    # "none"   → skip vectors entirely, retrieval is BM25-only (still works)
    embedding_backend: str = "local"
    embedding_model: str = "all-MiniLM-L6-v2"

    # ── Database ──────────────────────────────────────────
    # Postgres in Docker; SQLite is the zero-config local fallback.
    database_url: str = "sqlite+aiosqlite:///./clearchart.db"

    # ── Redis / queue ─────────────────────────────────────
    redis_url: str = "redis://localhost:6379"

    # ── Storage ───────────────────────────────────────────
    upload_dir: str = "./uploads"

    # ── Auth ──────────────────────────────────────────────
    # HMAC secret for signing session tokens. MUST be overridden in prod.
    secret_key: str = "clearchart-dev-secret-change-me"
    token_ttl_days: int = 30

    # ── Misc ──────────────────────────────────────────────
    cors_origins: str = "*"                           # comma-separated in prod
    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    """Cached singleton — import this everywhere instead of re-reading env."""
    return Settings()


settings = get_settings()
