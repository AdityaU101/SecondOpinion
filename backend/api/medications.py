"""
Medication routes — the medication review feature.

RETRIEVAL, NOT RECALL:
  Every fact shown to the user is retrieved live from authoritative sources:
    - NIH RxNav (rxnav.nlm.nih.gov) for name search/normalisation
    - openFDA drug labels (api.fda.gov) — the FDA/DailyMed SPL corpus —
      for interactions, warnings, adverse reactions, and dosing text
  The LLM (when configured) is only allowed to REPHRASE retrieved excerpts
  into plain English; the raw excerpts and their citations are always
  returned alongside so nothing rests on model memory.

  If a label can't be found, we say exactly that — no invented interactions.
"""
from __future__ import annotations

import asyncio
import logging
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.auth import get_current_user
from api.profiles import resolve_profile
from config import settings
from db.database import get_db
from db.models import Medication, User

log = logging.getLogger("clearchart.medications")

router = APIRouter(prefix="/api/v1/medications", tags=["medications"])

RXNAV_URL = "https://rxnav.nlm.nih.gov/REST/approximateTerm.json"
OPENFDA_URL = "https://api.fda.gov/drug/label.json"
DAILYMED_URL = "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid={setid}"

_EXCERPT_CHARS = 420

# In-process label cache — labels change rarely and openFDA rate-limits.
_label_cache: dict[str, dict | None] = {}


# ── SCHEMAS ──────────────────────────────────────────────

class MedicationRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    profile_id: str | None = None


class AnalyzeRequest(BaseModel):
    medications: list[str] = Field(..., min_length=1, max_length=12)


# ── LIST CRUD (per profile; guests keep theirs in localStorage) ──

@router.get("")
async def list_medications(
    profile_id: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    profile = await resolve_profile(user, profile_id, db)
    result = await db.execute(
        select(Medication)
        .where(Medication.user_id == user.id, Medication.profile_id == profile.id)
        .order_by(Medication.created_at)
    )
    return {"profile_id": profile.id, "medications": [m.to_dict() for m in result.scalars().all()]}


@router.post("", status_code=201)
async def add_medication(
    body: MedicationRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    profile = await resolve_profile(user, body.profile_id, db)
    name = body.name.strip()

    existing = await db.execute(
        select(Medication).where(
            Medication.user_id == user.id,
            Medication.profile_id == profile.id,
        )
    )
    meds = existing.scalars().all()
    if len(meds) >= 12:
        raise HTTPException(status_code=400, detail="A profile can track up to 12 medications.")
    if any(m.name.lower() == name.lower() for m in meds):
        raise HTTPException(status_code=409, detail=f"{name} is already on this list.")

    med = Medication(user_id=user.id, profile_id=profile.id, name=name)
    db.add(med)
    await db.commit()
    return med.to_dict()


@router.delete("/{med_id}", status_code=204)
async def remove_medication(
    med_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Medication).where(Medication.id == med_id, Medication.user_id == user.id)
    )
    med = result.scalar_one_or_none()
    if not med:
        raise HTTPException(status_code=404, detail="Medication not found.")
    await db.delete(med)
    await db.commit()


# ── SEARCH (NIH RxNav) ───────────────────────────────────

@router.get("/search")
async def search_medications(q: str = Query(..., min_length=2, max_length=80)):
    """Name suggestions from NIH RxNav's approximate-match API."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.get(RXNAV_URL, params={"term": q, "maxEntries": 12})
            res.raise_for_status()
            data = res.json()
    except Exception as exc:  # noqa: BLE001 — degrade to "no suggestions"
        log.warning("RxNav search failed: %s", exc)
        return {"suggestions": []}

    seen: set[str] = set()
    suggestions: list[str] = []
    for cand in (data.get("approximateGroup", {}).get("candidate") or []):
        name = (cand.get("name") or "").strip()
        key = name.lower()
        if name and key not in seen and len(name) < 60:
            seen.add(key)
            suggestions.append(name)
        if len(suggestions) >= 8:
            break
    return {"suggestions": suggestions}


# ── LABEL RETRIEVAL (openFDA / DailyMed) ─────────────────

def _first_text(label: dict, field: str) -> str:
    value = label.get(field)
    if isinstance(value, list) and value:
        return " ".join(str(v) for v in value)
    return str(value) if value else ""


def _clip(text: str, limit: int = _EXCERPT_CHARS) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    # end on a sentence boundary when one exists in the back half
    dot = cut.rfind(". ")
    return (cut[: dot + 1] if dot > limit // 2 else cut.rstrip() + "…")


def _sentences_matching(text: str, pattern: re.Pattern, limit: int = 2) -> list[str]:
    hits = []
    for sentence in re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", text)):
        if pattern.search(sentence):
            hits.append(_clip(sentence))
        if len(hits) >= limit:
            break
    return hits


async def _fetch_label(client: httpx.AsyncClient, name: str) -> dict | None:
    key = name.lower().strip()
    if key in _label_cache:
        return _label_cache[key]

    query = f'(openfda.generic_name:"{key}" OR openfda.brand_name:"{key}")'
    label = None
    try:
        res = await client.get(OPENFDA_URL, params={"search": query, "limit": 1})
        if res.status_code == 200:
            results = res.json().get("results") or []
            label = results[0] if results else None
    except Exception as exc:  # noqa: BLE001
        log.warning("openFDA lookup failed for %s: %s", name, exc)
        return None  # transient — don't cache

    _label_cache[key] = label
    return label


_FOOD_RE = re.compile(r"grapefruit|food|meal|dairy|caffeine|vitamin k|leafy green", re.I)
_ALCOHOL_RE = re.compile(r"alcohol|alcoholic beverage|ethanol", re.I)
_MONITOR_RE = re.compile(r"monitor|blood test|liver function|renal function|kidney function|check .{0,20}levels|periodic", re.I)


def _summarize_label(name: str, label: dict) -> dict:
    """Extract the patient-relevant sections of one FDA label, verbatim-clipped."""
    openfda = label.get("openfda", {}) or {}
    generic = (openfda.get("generic_name") or [name])[0]
    brand = (openfda.get("brand_name") or [""])[0]
    setid = (openfda.get("spl_set_id") or [None])[0]

    interactions_text = _first_text(label, "drug_interactions")
    warnings_text = " ".join(
        _first_text(label, f) for f in ("boxed_warning", "warnings", "warnings_and_cautions")
    ).strip()
    adverse_text = _first_text(label, "adverse_reactions")
    dosage_text = _first_text(label, "dosage_and_administration")
    info_text = _first_text(label, "information_for_patients")

    searchable = " ".join([interactions_text, warnings_text, info_text])

    return {
        "name": name,
        "generic_name": generic,
        "brand_name": brand,
        "found": True,
        "source": {
            "label": f"FDA drug label for {brand or generic} (openFDA / DailyMed)",
            "url": DAILYMED_URL.format(setid=setid) if setid else "https://open.fda.gov/apis/drug/label/",
        },
        "sections": {
            "side_effects": _clip(adverse_text) if adverse_text else None,
            "food": _sentences_matching(searchable, _FOOD_RE) or None,
            "alcohol": _sentences_matching(searchable, _ALCOHOL_RE) or None,
            "timing": _clip(dosage_text, 320) if dosage_text else None,
            "monitoring": _sentences_matching(warnings_text + " " + info_text, _MONITOR_RE) or None,
        },
        "_interactions_text": interactions_text,   # internal, used for pairing
    }


def _find_pairwise_interactions(meds: list[dict]) -> list[dict]:
    """A mention of drug B inside drug A's official interactions section is an
    authoritative signal; anything else is deliberately NOT reported."""
    findings = []
    for a in meds:
        text = a.get("_interactions_text") or ""
        if not text:
            continue
        for b in meds:
            if a is b:
                continue
            terms = {t for t in (b["name"], b.get("generic_name"), b.get("brand_name")) if t}
            for term in terms:
                pattern = re.compile(re.escape(term), re.I)
                if pattern.search(text):
                    sentences = _sentences_matching(text, pattern, limit=2)
                    findings.append({
                        "pair": [a["name"], b["name"]],
                        "excerpt": " ".join(sentences) if sentences else _clip(text),
                        "source": a["source"],
                    })
                    break
    # de-duplicate unordered pairs, keeping the first excerpt found
    seen: set[frozenset] = set()
    unique = []
    for f in findings:
        key = frozenset(n.lower() for n in f["pair"])
        if key not in seen:
            seen.add(key)
            unique.append(f)
    return unique


async def _plain_english_gloss(meds: list[dict], interactions: list[dict]) -> str | None:
    """One constrained LLM pass that may ONLY rephrase the retrieved excerpts."""
    if not settings.groq_api_key:
        return None

    lines = []
    for m in meds:
        if not m["found"]:
            lines.append(f"{m['name']}: no label found.")
            continue
        s = m["sections"]
        parts = []
        if s["side_effects"]: parts.append(f"side effects: {s['side_effects']}")
        if s["food"]: parts.append(f"food: {' '.join(s['food'])}")
        if s["alcohol"]: parts.append(f"alcohol: {' '.join(s['alcohol'])}")
        if s["timing"]: parts.append(f"timing: {s['timing']}")
        if s["monitoring"]: parts.append(f"monitoring: {' '.join(s['monitoring'])}")
        lines.append(f"{m['name']} — " + " | ".join(parts) if parts else f"{m['name']}: label found but sections empty.")
    for i in interactions:
        lines.append(f"INTERACTION {i['pair'][0]} + {i['pair'][1]}: {i['excerpt']}")

    prompt = (
        "Rewrite the following FDA drug-label excerpts as a short plain-English overview "
        "for a patient (4-8 sentences). STRICT RULES: use ONLY facts present in the excerpts; "
        "do not add interactions, effects, or advice that is not in them; no markdown; "
        "if the excerpts are sparse, keep the overview short rather than padding it.\n\n"
        + "\n".join(lines)
    )

    try:
        from groq import AsyncGroq

        client = AsyncGroq(api_key=settings.groq_api_key)
        response = await client.chat.completions.create(
            model=settings.llm_model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=400,
            temperature=0.2,
        )
        return (response.choices[0].message.content or "").strip() or None
    except Exception as exc:  # noqa: BLE001
        log.warning("gloss generation failed: %s", exc)
        return None


@router.post("/analyze")
async def analyze_medications(body: AnalyzeRequest):
    """Open to guests too — analysis is stateless and stores nothing."""
    names = [n.strip() for n in body.medications if n.strip()][:12]
    if not names:
        raise HTTPException(status_code=400, detail="Add at least one medication first.")

    async with httpx.AsyncClient(timeout=10) as client:
        labels = await asyncio.gather(*(_fetch_label(client, n) for n in names))

    meds = []
    for name, label in zip(names, labels):
        if label:
            meds.append(_summarize_label(name, label))
        else:
            meds.append({
                "name": name, "generic_name": name, "brand_name": "", "found": False,
                "source": None, "sections": None, "_interactions_text": "",
            })

    interactions = _find_pairwise_interactions(meds)
    overview = await _plain_english_gloss(meds, interactions)

    for m in meds:                      # strip the internal field before returning
        m.pop("_interactions_text", None)

    return {
        "overview": overview,
        "medications": meds,
        "interactions": interactions,
        "note": (
            "Checked against FDA drug labels via openFDA/DailyMed and NIH RxNav. "
            "Only label-documented information is shown; absence of a warning here "
            "does not mean an interaction cannot exist."
        ),
    }
