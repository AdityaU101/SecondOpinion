"""
"Explain This Value" support route.

The drawer that opens when a lab value is clicked is assembled almost
entirely on the frontend from data the app already has (the finding itself,
the curated glossary, the profile's medication list). The only thing the
backend adds is guideline evidence: this route reuses the existing hybrid
RAG retriever to fetch citation passages for one biomarker.

No LLM: the drawer must be instant, and its content is either curated
(glossary), rule-validated (the finding), or retrieved verbatim with its
source (citations) — there is nothing for a model to safely add.
Degrades gracefully: retrieval failure → empty citations, drawer still works.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Query

router = APIRouter(prefix="/api/v1", tags=["explain"])
log = logging.getLogger("clearchart.explain")


@router.get("/explain")
async def explain_value(q: str = Query(..., min_length=1, max_length=120)):
    """Guideline citations for one biomarker, via the existing RAG index."""
    try:
        from rag.retriever import retrieve
        passages = await retrieve(q)
    except Exception as exc:  # noqa: BLE001 — citations are optional enrichment
        log.warning("explain retrieval failed for %r: %s", q, exc)
        passages = []
    return {
        "query": q,
        "citations": [
            {"source": p.get("source"), "passage": p.get("passage"), "url": p.get("url")}
            for p in (passages or [])[:4]
        ],
    }
