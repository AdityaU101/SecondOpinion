"""
Message-queue client (the "producer" side of Phase 6 decoupling).

The API does NOT run analysis itself. It drops a job onto Redis and returns
202 Accepted immediately. A separate `worker` process (the "consumer") picks
it up. Producer and consumer scale independently: a backlog of slow analyses
never makes the upload endpoint slow.

We use arq (async Redis queue) rather than Celery/RQ because our pipeline is
already async (async DB, async Anthropic client). arq runs coroutines natively,
so there's no sync/async bridge to maintain.

Resilience: if Redis is down, `enqueue_analysis` returns False and the caller
falls back to running the job inline. The system degrades, it doesn't crash.
"""
from __future__ import annotations
import logging
from typing import Optional

from arq import create_pool
from arq.connections import RedisSettings

from config import settings

log = logging.getLogger(__name__)

_pool = None  # set once at API startup


def redis_settings() -> RedisSettings:
    """Shared Redis connection config — used by both the pool and the worker."""
    rs = RedisSettings.from_dsn(settings.redis_url)
    # Fail fast when Redis isn't running (local no-Docker dev) so the API falls
    # back to inline processing in ~1s instead of hanging on retries.
    rs.conn_timeout = 1
    rs.conn_retries = 1
    rs.conn_retry_delay = 1
    return rs


async def init_pool() -> None:
    """Create the Redis connection pool (called from the API lifespan)."""
    global _pool
    try:
        _pool = await create_pool(redis_settings())
        log.info("Connected to Redis queue at %s", settings.redis_url)
    except Exception as exc:  # noqa: BLE001
        _pool = None
        log.warning("Redis unavailable (%s) — falling back to inline processing", exc)


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def enqueue_analysis(
    job_id: str,
    file_path: Optional[str],
    raw_text: Optional[str],
    source_name: str,
) -> bool:
    """
    Push an analysis task onto the queue.
    Returns True if enqueued, False if the queue is unavailable.
    """
    if _pool is None:
        return False
    try:
        await _pool.enqueue_job(
            "analyze_job", job_id, file_path, raw_text, source_name
        )
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("Enqueue failed for job %s: %s", job_id, exc)
        return False
