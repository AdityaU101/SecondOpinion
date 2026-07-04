"""
RAG Retriever — hybrid BM25 + FAISS vector search over clinical guidelines.

WHY HYBRID SEARCH (not just vector search)?
  Medical documents are full of abbreviations and lab codes:
  "eGFR", "HbA1c", "LDL-C", "AST/ALT". These terms are rare
  in the embedding model's training data, so their vectors are
  noisy. BM25 (keyword search) handles them perfectly because
  it's exact-match — "eGFR" in the query hits "eGFR" in the
  passage every time, regardless of vector distance.

  Cosine similarity handles conceptual queries: "my kidney
  numbers look weird" → retrieves GFR/creatinine passages
  because the vectors are semantically close, even without
  the exact word.

  Combining both via Reciprocal Rank Fusion (RRF) gives us the
  best of both: exact term matching + semantic understanding.

ARCHITECTURE:
  - Guidelines are loaded from kb/guidelines.json at startup.
  - Embeddings are computed once and cached to kb/faiss.index.
  - Retrieval at query time: BM25 score + cosine score → RRF.

FAISS vs ChromaDB:
  FAISS is a pure in-process library (no server, no network).
  ChromaDB is better for multi-collection / multi-tenant use.
  For a demo with a single guidelines KB, FAISS is lighter and
  faster. In production you'd use Pinecone or Weaviate for
  multi-tenancy and managed scaling.
"""
from __future__ import annotations
import json
import logging
import math
import os
import pickle
import re
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

from config import settings

_KB_PATH    = Path(__file__).parent.parent / "kb" / "guidelines.json"
# Cache files are namespaced by backend so a stale index from a different
# embedding model (e.g. an old 1536-dim OpenAI cache) never gets loaded.
_INDEX_PATH = Path(__file__).parent.parent / "kb" / "faiss_local.index"
_EMB_PATH   = Path(__file__).parent.parent / "kb" / "embeddings_local.pkl"

# Optional heavy imports
try:
    import numpy as np
    _HAS_NUMPY = True
except ImportError:
    _HAS_NUMPY = False

try:
    import faiss
    _HAS_FAISS = True
except ImportError:
    _HAS_FAISS = False
    log.warning("faiss-cpu not installed — vector retrieval will be skipped")

try:
    from sentence_transformers import SentenceTransformer
    _HAS_ST = True
except ImportError:
    _HAS_ST = False
    log.warning("sentence-transformers not installed — retrieval will be BM25-only")

_VECTORS_ENABLED = settings.embedding_backend == "local"
TOP_K       = 6     # passages to return per query
RRF_K       = 60    # RRF constant (60 is standard)

# Lazily-loaded embedding model (loading it is ~1s; do it once, on demand)
_st_model = None


def _get_model():
    global _st_model
    if _st_model is None:
        _st_model = SentenceTransformer(settings.embedding_model)
    return _st_model


def _embed(texts: list[str]):
    """Encode texts to L2-normalised float32 vectors for cosine search."""
    vecs = _get_model().encode(texts, convert_to_numpy=True, normalize_embeddings=True)
    return vecs.astype("float32")


# ── GLOBALS (populated at startup) ───────────────────────
_guidelines:  list[dict]      = []   # raw guideline dicts
_bm25_index:  Optional[object] = None
_faiss_index: Optional[object] = None
_embeddings:  Optional[object] = None   # np.ndarray shape (N, 1536)


# ── PUBLIC API ────────────────────────────────────────────

async def build_index() -> None:
    """
    Load guidelines and build the search index.
    Called once at server startup via lifespan.
    Idempotent — safe to call multiple times.
    """
    global _guidelines, _bm25_index, _faiss_index, _embeddings

    _guidelines = _load_guidelines()
    if not _guidelines:
        log.warning("No guidelines found at %s", _KB_PATH)
        return

    log.info("Building retrieval index over %d guidelines…", len(_guidelines))

    # BM25 index (always available — no heavy deps)
    _bm25_index = BM25Index([g["passage"] for g in _guidelines])

    # FAISS vector index (local sentence-transformers embeddings — no API key)
    if _HAS_FAISS and _HAS_NUMPY and _HAS_ST and _VECTORS_ENABLED:
        if _EMB_PATH.exists() and _INDEX_PATH.exists():
            log.info("Loading cached FAISS index…")
            _faiss_index, _embeddings = _load_faiss_cache()
        else:
            log.info("Computing guideline embeddings (first run only)…")
            _faiss_index, _embeddings = _build_faiss_index(_guidelines)
            _save_faiss_cache(_faiss_index, _embeddings)
    else:
        log.info("FAISS index skipped (deps missing or disabled) — BM25 only")

    log.info("Retrieval index ready.")


async def retrieve(query: str, top_k: int = TOP_K) -> list[dict]:
    """
    Retrieve the most relevant clinical guideline passages for a query.
    Returns a list of guideline dicts with an added 'score' field.
    """
    if not _guidelines:
        return []

    bm25_ranks = _bm25_ranks(query)
    faiss_ranks = _faiss_ranks(query) if _faiss_index is not None else {}

    # Reciprocal Rank Fusion
    rrf_scores: dict[int, float] = {}
    for idx, rank in bm25_ranks.items():
        rrf_scores[idx] = rrf_scores.get(idx, 0) + 1.0 / (RRF_K + rank)
    for idx, rank in faiss_ranks.items():
        rrf_scores[idx] = rrf_scores.get(idx, 0) + 1.0 / (RRF_K + rank)

    # Sort by combined score, take top_k
    sorted_idx = sorted(rrf_scores, key=lambda i: rrf_scores[i], reverse=True)[:top_k]

    results = []
    for idx in sorted_idx:
        g = _guidelines[idx].copy()
        g["score"] = round(rrf_scores[idx], 4)
        results.append(g)

    return results


# ── BM25 (pure Python, no deps) ───────────────────────────

class BM25Index:
    """
    Minimal BM25 implementation.
    BM25 is the industry standard for keyword retrieval — it's what
    Elasticsearch uses under the hood. k1=1.5, b=0.75 are standard defaults.
    """
    def __init__(self, corpus: list[str], k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b  = b
        self.corpus_size = len(corpus)
        self.tokenised   = [self._tokenise(doc) for doc in corpus]
        self.avgdl       = sum(len(d) for d in self.tokenised) / max(self.corpus_size, 1)
        self.df          = self._compute_df()
        self.idf         = self._compute_idf()

    def score(self, query: str) -> list[float]:
        tokens = self._tokenise(query)
        scores = []
        for doc_tokens in self.tokenised:
            tf_map = {}
            for t in doc_tokens:
                tf_map[t] = tf_map.get(t, 0) + 1
            s = 0.0
            dl = len(doc_tokens)
            for t in tokens:
                if t not in self.idf:
                    continue
                tf = tf_map.get(t, 0)
                num = tf * (self.k1 + 1)
                den = tf + self.k1 * (1 - self.b + self.b * dl / self.avgdl)
                s += self.idf[t] * (num / den)
            scores.append(s)
        return scores

    def _tokenise(self, text: str) -> list[str]:
        return re.findall(r"[A-Za-z0-9]+", text.lower())

    def _compute_df(self) -> dict[str, int]:
        df: dict[str, int] = {}
        for doc in self.tokenised:
            for t in set(doc):
                df[t] = df.get(t, 0) + 1
        return df

    def _compute_idf(self) -> dict[str, float]:
        idf: dict[str, float] = {}
        N = self.corpus_size
        for term, freq in self.df.items():
            idf[term] = math.log((N - freq + 0.5) / (freq + 0.5) + 1)
        return idf


def _bm25_ranks(query: str) -> dict[int, int]:
    if _bm25_index is None:
        return {}
    scores = _bm25_index.score(query)
    ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    return {idx: rank + 1 for rank, idx in enumerate(ranked)}


def _faiss_ranks(query: str) -> dict[int, int]:
    if _faiss_index is None or not _HAS_NUMPY or not _HAS_ST:
        return {}
    try:
        vec = _embed([query])  # already L2-normalised
        k = min(len(_guidelines), TOP_K * 2)
        _, indices = _faiss_index.search(vec, k)
        return {int(idx): rank + 1 for rank, idx in enumerate(indices[0]) if idx >= 0}
    except Exception as exc:
        log.warning("FAISS query failed: %s", exc)
        return {}


# ── FAISS INDEX BUILD / CACHE ─────────────────────────────

def _build_faiss_index(guidelines: list[dict]):
    passages = [g["passage"] for g in guidelines]
    vecs = _embed(passages)  # L2-normalised float32
    index = faiss.IndexFlatIP(vecs.shape[1])  # inner product on unit vectors = cosine
    index.add(vecs)
    return index, vecs


def _save_faiss_cache(index, embeddings):
    faiss.write_index(index, str(_INDEX_PATH))
    with open(_EMB_PATH, "wb") as f:
        pickle.dump(embeddings, f)
    log.info("FAISS index cached to %s", _INDEX_PATH)


def _load_faiss_cache():
    index = faiss.read_index(str(_INDEX_PATH))
    with open(_EMB_PATH, "rb") as f:
        embeddings = pickle.load(f)
    return index, embeddings


# ── GUIDELINE LOADER ──────────────────────────────────────

def _load_guidelines() -> list[dict]:
    try:
        with open(_KB_PATH, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        log.error("Guidelines file not found at %s", _KB_PATH)
        return []
    except json.JSONDecodeError as e:
        log.error("Failed to parse guidelines JSON: %s", e)
        return []
