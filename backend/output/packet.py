"""
Doctor Visit Packet builder.

Assembles an appointment-ready packet from data the system has ALREADY
produced — the job's stored report JSON, prior reports for the same profile,
and the saved medication list. Analysis is never re-run and the rule engine
is never touched.

Two-layer split, same as the main pipeline:
  1. Everything factual (priority values, wellness scores, timeline sentences,
     checklist) is assembled deterministically in this module.
  2. One OPTIONAL Groq call rewrites the already-determined facts into a short
     patient-friendly opening note. If the LLM is unavailable or fails, a
     deterministic note is used instead — the packet never hard-fails.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime

log = logging.getLogger("clearchart.packet")

_SEVERITY_ORDER = {"critical": 0, "moderate": 1, "mild": 2, "normal": 3}
_MAX_PRIORITY = 6
_MAX_TIMELINE = 4


# ── PUBLIC API ────────────────────────────────────────────

async def generate_packet(
    job_id: str,
    report: dict,
    *,
    profile_name: str,
    report_date: str | None,
    medications: list[str],
    prior_entries: list[dict],
) -> dict:
    """Build the full packet dict (deterministic core + optional LLM note).

    prior_entries: [{"date": iso-string, "findings": [finding-dicts]}] for the
    same profile, oldest first, INCLUDING the current report's entry.
    """
    packet = _build_deterministic(
        job_id, report,
        profile_name=profile_name,
        report_date=report_date,
        medications=medications,
        prior_entries=prior_entries,
    )

    note = await _polish_visit_note(packet)
    if note:
        packet["visit_note"] = note
        packet["visit_note_source"] = "llm"
    return packet


# ── DETERMINISTIC ASSEMBLY ────────────────────────────────

def _build_deterministic(
    job_id: str,
    report: dict,
    *,
    profile_name: str,
    report_date: str | None,
    medications: list[str],
    prior_entries: list[dict],
) -> dict:
    findings = report.get("findings") or []
    abnormal = [f for f in findings if (f.get("status") or "").lower() != "normal"]
    abnormal.sort(key=lambda f: _SEVERITY_ORDER.get((f.get("severity") or "").lower(), 9))
    priority = abnormal[:_MAX_PRIORITY] or findings[:3]

    timeline = _build_timeline(prior_entries)
    urgency = report.get("urgency") or "routine"

    packet = {
        "job_id": job_id,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "profile_name": profile_name,
        "report_date": report_date,
        "urgency": urgency,
        "visit_note": _fallback_note(profile_name, abnormal, len(findings)),
        "visit_note_source": "deterministic",
        "priority_findings": [
            {
                "parameter": f.get("parameter"),
                "value": f.get("value"),
                "status": f.get("status"),
                "severity": f.get("severity"),
                "reference_range": f.get("reference_range"),
            }
            for f in priority
        ],
        "wellness": [
            {
                "area": d.get("area"),
                "score": d.get("score"),
                "status": d.get("status"),
                "note": d.get("note"),
            }
            for d in (report.get("health_snapshot") or [])
        ],
        "timeline": timeline,
        "medications": medications,
        "questions": [
            {"question": q.get("question"), "context": q.get("context")}
            for q in (report.get("questions_for_doctor") or [])
        ],
        "checklist": _build_checklist(urgency, abnormal, medications, timeline),
        "citations": [
            {"source": c.get("source"), "passage": c.get("passage"), "url": c.get("url")}
            for c in (report.get("citations") or [])
        ],
        "disclaimer": report.get("disclaimer") or "",
    }
    return packet


def _fallback_note(profile_name: str, abnormal: list[dict], total: int) -> str:
    """Deterministic opening note — used verbatim when the LLM is unavailable."""
    who = f"{profile_name}'s" if profile_name else "my"
    if not abnormal:
        return (
            f"This packet summarizes {who} recent report: {total} value(s) were "
            "checked and all were within their reference ranges. The sections "
            "below list the exact values, questions to ask, and a follow-up checklist."
        )
    names = ", ".join(f.get("parameter") or "" for f in abnormal[:3])
    return (
        f"This packet summarizes {who} recent report: {len(abnormal)} value(s) "
        f"were outside the reference range ({names}). The sections below list "
        "the exact values, questions to ask, and a follow-up checklist."
    )


def _build_checklist(
    urgency: str,
    abnormal: list[dict],
    medications: list[str],
    timeline: list[str],
) -> list[str]:
    """Follow-up checklist derived only from what the report already decided."""
    items: list[str] = []
    if urgency == "urgent":
        items.append("Book an appointment soon to discuss the flagged values on this sheet.")
    elif urgency == "watch":
        items.append("Bring up the flagged values at your next appointment.")
    items.append("Bring this packet and the original lab report to the visit.")
    if abnormal:
        names = ", ".join(dict.fromkeys(f.get("parameter") or "" for f in abnormal[:4]))
        items.append(f"Ask when to re-test: {names}.")
    if timeline:
        items.append("Ask whether the trends on this sheet change the plan.")
    if medications:
        items.append("Review the medication list on this sheet with your doctor or pharmacist.")
    items.append("Write the agreed next steps in the physician notes box before leaving.")
    return items


# ── TIMELINE (deterministic, mirrors the frontend trend sentences) ──

def _norm(name: str | None) -> str:
    return "".join(ch if ch.isalnum() else " " for ch in (name or "").lower()).strip()


def _fmt(n) -> str:
    if n is None:
        return ""
    if float(n) == int(n):
        return str(int(n))
    return str(round(float(n), 1))


def _build_timeline(entries: list[dict]) -> list[str]:
    """One grounded sentence per lab value seen in >=2 reports: direction,
    size of the change, and where the latest value sits against the healthy
    range. Built ONLY from stored report values — nothing is invented."""
    by_param: dict[str, dict] = {}
    for entry in entries:
        for f in entry.get("findings") or []:
            v = f.get("numeric_value")
            if v is None:
                continue
            key = _norm(f.get("parameter"))
            if not key:
                continue
            series = by_param.setdefault(key, {"name": f.get("parameter"), "unit": f.get("unit"), "points": []})
            series["points"].append({
                "value": float(v),
                "ref_low": f.get("ref_low"),
                "ref_high": f.get("ref_high"),
            })

    sentences: list[str] = []
    for series in by_param.values():
        if len(sentences) >= _MAX_TIMELINE:
            break
        s = _trend_sentence(series)
        if s:
            sentences.append(s)
    return sentences


def _trend_sentence(series: dict) -> str | None:
    pts = series["points"]
    if len(pts) < 2:
        return None
    first, latest = pts[0]["value"], pts[-1]["value"]
    if first == 0 and latest == 0:
        return None

    pct = round((latest - first) / abs(first) * 100) if first != 0 else None
    unit = f" {series['unit']}" if series.get("unit") else ""
    span = f"across {len(pts)} reports ({_fmt(first)} -> {_fmt(latest)}{unit})"

    diffs = [pts[i]["value"] - pts[i - 1]["value"] for i in range(1, len(pts))]
    rises = sum(1 for d in diffs if d > 0)
    falls = sum(1 for d in diffs if d < 0)
    if pct is not None and abs(pct) < 3:
        movement = "has stayed steady"
    elif falls == 0:
        movement = f"has {'steadily ' if len(diffs) > 1 else ''}risen {abs(pct)}%"
    elif rises == 0:
        movement = f"has {'steadily ' if len(diffs) > 1 else ''}fallen {abs(pct)}%"
    else:
        movement = f"has fluctuated, ending {'up' if latest > first else 'down'} {abs(pct)}%"

    ref = pts[-1]
    ref_high, ref_low = ref.get("ref_high"), ref.get("ref_low")
    has_high = ref_high is not None and ref_high < 9000
    has_low = ref_low is not None and ref_low > 0
    position = ""
    if has_high and latest > ref_high:
        improving = first > ref_high and latest < first
        position = (" — moving toward the healthy range, but still above it"
                    if improving else " and remains above the healthy range")
    elif has_low and latest < ref_low:
        improving = first < ref_low and latest > first
        position = (" — moving toward the healthy range, but still below it"
                    if improving else " and remains below the healthy range")
    elif has_high or has_low:
        was_out = (has_high and first > ref_high) or (has_low and first < ref_low)
        position = " and is now within the healthy range" if was_out else " and stays within the healthy range"

    return f"{series['name']} {movement} {span}{position}."


# ── OPTIONAL LLM REWRITE ──────────────────────────────────
# The model receives ONLY facts the deterministic layer already decided and
# may only rephrase them. No numbers, no diagnosis, no new medical claims.

_NOTE_TOOL = {
    "type": "function",
    "function": {
        "name": "emit_visit_note",
        "description": "Return the rewritten patient-friendly opening note.",
        "parameters": {
            "type": "object",
            "properties": {
                "note": {
                    "type": "string",
                    "description": "3-5 sentences, Grade 8 reading level, first person.",
                }
            },
            "required": ["note"],
        },
    },
}

_NOTE_SYSTEM = """
You rewrite verified medical-report facts into a short note a patient reads to
open their doctor's appointment.

STRICT RULES:
- Use ONLY the facts provided. Do not add, remove, or change any number, value,
  or medical claim. Do not interpret ranges — their status is already decided.
- Never diagnose, never suggest treatments or medication changes.
- 3-5 sentences, first person ("I"/"my" — or the profile name if it is a family
  member), Grade 8 reading level, calm and practical.
- Return the note ONLY by calling emit_visit_note.
""".strip()


async def _polish_visit_note(packet: dict) -> str | None:
    """One LLM call to rephrase the packet facts. Any failure → None."""
    from llm import chat_completion, llm_available
    if not llm_available():
        return None

    facts = {
        "profile_name": packet.get("profile_name") or "the patient (first person)",
        "report_date": packet.get("report_date"),
        "urgency": packet.get("urgency"),
        "flagged_values": [
            f"{f.get('parameter')}: {f.get('value')} ({f.get('status')}"
            + (f", healthy {f.get('reference_range')})" if f.get("reference_range") else ")")
            for f in packet.get("priority_findings") or []
            if (f.get("status") or "").lower() != "normal"
        ],
        "timeline": packet.get("timeline") or [],
        "medication_count": len(packet.get("medications") or []),
    }

    try:
        response = await chat_completion(
            messages=[
                {"role": "system", "content": _NOTE_SYSTEM},
                {"role": "user", "content": "<facts>\n" + json.dumps(facts, indent=2) + "\n</facts>\n\nRewrite these facts as the opening note and call emit_visit_note."},
            ],
            max_tokens=400,
            temperature=0.2,
            tools=[_NOTE_TOOL],
            tool_choice={"type": "function", "function": {"name": "emit_visit_note"}},
        )
        for call in response.choices[0].message.tool_calls or []:
            if call.function.name == "emit_visit_note":
                note = (json.loads(call.function.arguments).get("note") or "").strip()
                if 40 <= len(note) <= 1200:
                    return note
    except Exception as exc:  # noqa: BLE001
        log.warning("Visit-note rewrite failed (%s) — using deterministic note", exc)
    return None
