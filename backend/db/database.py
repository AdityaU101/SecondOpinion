"""
Database setup — SQLAlchemy async with SQLite.

WHY SQLITE FOR THE DEMO?
  Zero installation, single file, identical SQL to PostgreSQL.
  To swap to Postgres later: change DATABASE_URL to
  "postgresql+asyncpg://user:pass@localhost/clearchart"
  and run `pip install asyncpg`. Nothing else changes.

WHY SQLALCHEMY ASYNC?
  FastAPI is fully async. Using sync SQLAlchemy would block the
  event loop during every DB call — defeating the point of async.
  AsyncSession + aiosqlite gives us non-blocking DB I/O.
"""
from __future__ import annotations
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from config import settings

# ── CONNECTION URL ────────────────────────────────────────
# Postgres/Neon:  postgresql+asyncpg://user:pass@host/dbname
# SQLite (local): sqlite+aiosqlite:///./clearchart.db
#
# Neon (and most managed Postgres) hand you a libpq-style URL with query params
# like "?sslmode=require&channel_binding=require". asyncpg doesn't understand
# those, so we strip them and enable TLS via connect_args instead.
_raw_url = settings.database_url
_IS_SQLITE = _raw_url.startswith("sqlite")

if not _IS_SQLITE:
    # Normalise a bare "postgresql://" to the async driver.
    if _raw_url.startswith("postgresql://"):
        _raw_url = _raw_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if _raw_url.startswith("postgres://"):
        _raw_url = _raw_url.replace("postgres://", "postgresql+asyncpg://", 1)

_needs_ssl = not _IS_SQLITE
DATABASE_URL = _raw_url.split("?", 1)[0] if not _IS_SQLITE else _raw_url

_connect_args: dict = {}
if _IS_SQLITE:
    _connect_args = {"check_same_thread": False}
elif _needs_ssl:
    # asyncpg: enable TLS (Neon requires it). Neon's *-pooler* endpoint runs
    # PgBouncer in transaction mode, which breaks asyncpg's default prepared-
    # statement caching — so we disable both caches to stay pooler-safe.
    _connect_args = {
        "ssl": True,
        "statement_cache_size": 0,            # asyncpg-level cache off
        "prepared_statement_cache_size": 0,   # SQLAlchemy asyncpg-dialect cache off
    }

# ── ENGINE ────────────────────────────────────────────────
# pool_pre_ping recycles dead connections (Neon closes idle ones aggressively).
engine = create_async_engine(
    DATABASE_URL,
    connect_args=_connect_args,
    pool_pre_ping=not _IS_SQLITE,
    echo=False,        # set True to log all SQL (useful for debugging)
)

# ── SESSION FACTORY ───────────────────────────────────────
AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

# ── BASE CLASS ────────────────────────────────────────────
class Base(DeclarativeBase):
    pass


# ── DEPENDENCY ────────────────────────────────────────────
async def get_db() -> AsyncSession:
    """
    FastAPI dependency — yields a DB session and guarantees it closes.

    Usage in a route:
        async def my_route(db: AsyncSession = Depends(get_db)):
            ...
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


# ── INIT ──────────────────────────────────────────────────
async def create_tables():
    """Create all tables on startup (if they don't exist)."""
    async with engine.begin() as conn:
        # Import models here so Base knows about them
        from db import models  # noqa: F401
        await conn.run_sync(Base.metadata.create_all)

    # Minimal forward migrations: create_all never ALTERs existing tables,
    # so add columns introduced after the first release here. Each ALTER gets
    # its own transaction — on Postgres a failed statement poisons the tx.
    from sqlalchemy import text
    for ddl in (
        "ALTER TABLE jobs ADD COLUMN user_id VARCHAR(36)",
        "ALTER TABLE jobs ADD COLUMN profile_id VARCHAR(36)",
    ):
        try:
            async with engine.begin() as conn:
                await conn.execute(text(ddl))
        except Exception:
            pass  # column already exists
