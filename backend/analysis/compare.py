"""
Report Comparison engine — deterministic diff of two stored reports.

Every classification here is computed by plain code from the two reports'
STORED findings (which the rule engine already validated). The LLM never
computes anything: at most it rewrites the finished, structured comparison
into a short plain-English summary — and if it is unavailable, a
deterministic summary built from the same counts is used instead.

CLASSIFICATION RULES (biomarkers matched by normalised parameter name):
  present in both reports:
    normal -> abnormal ......... new_abnormalities
    abnormal -> normal ......... resolved
    abnormal -> abnormal ....... improved / worsened / unchanged, decided by
                                 the value's DISTANCE from the healthy range
                                 (closer = improved, farther = worsened,
                                 <3% relative change = unchanged)
    normal -> normal ........... unchanged ("stays within the healthy range")
  present only in the newer report:
    abnormal ................... new_abnormalities (flagged first_measurement)
    normal ..................... newly_measured
  present only in the older report:
    ............................ not_remeasured (note says whether it was
                                 flagged — "unresolved" — or normal)
Nothing is ever guessed: a biomarker missing on one side is labelled exactly
that, never interpolated.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

log = logging.getLogger("clearchart.compare")

_EPSILON_PCT = 3          # relative change below this = "unchanged"
_OPEN_UPPER = 9000        # ref_high >= this means "no upper limit" (app-wide convention)

BUCKETS = (
    "new_abnormalities", "resolved", "improved", "worsened",
    "unchanged", "newly_measured", "not_remeasured",
)


# ── PUBLIC API ────────────────────────────────────────────

async def generate_comparison(older: dict, newer: dict) -> dict:
    """Compare two completed reports.

    older/newer: {"job_id", "date", "source_name", "report": <stored report dict>}
    (caller orders them by creation time). Returns the full comparison dict
    with a deterministic summary, upgraded to an LLM-written one when Groq
    is available.
    """
    result = _build_comparison(older, newer)

    summary = await _rewrite_summary(result)
    if summary:
        result["summary"] = summary
        result["summary_source"] = "llm"
    return result


# ── DETERMINISTIC DIFF ────────────────────────────────────

def _norm(name: str | None) -> str:
    return "".join(ch if ch.isalnum() else " " for ch in (name or "").lower()).strip()


def _is_abnormal(f: dict) -> bool:
    return (f.get("status") or "").lower() != "normal"


def _side(f: dict | None) -> dict | None:
    """The per-report half of a comparison item (only fields the UI needs)."""
    if f is None:
        return None
    return {
        "value": f.get("value"),
        "numeric_value": f.get("numeric_value"),
        "unit": f.get("unit"),
        "status": f.get("status"),
        "severity": f.get("severity"),
        "ref_low": f.get("ref_low"),
        "ref_high": f.get("ref_high"),
        "reference_range": f.get("reference_range"),
    }


def _fmt(n) -> str:
    if n is None:
        return ""
    if float(n) == int(n):
        return str(int(n))
    return str(round(float(n), 2))


def _distance_from_range(v: float, ref_low, ref_high) -> float:
    """How far a value sits outside the healthy band (0 = inside)."""
    has_high = ref_high is not None and ref_high < _OPEN_UPPER
    has_low = ref_low is not None and ref_low > 0
    if has_high and v > ref_high:
        return v - ref_high
    if has_low and v < ref_low:
        return ref_low - v
    return 0.0


def _delta(old_v: float, new_v: float) -> dict:
    absolute = new_v - old_v
    percent = round(absolute / abs(old_v) * 100) if old_v != 0 else None
    return {
        "absolute": round(absolute, 2),
        "percent": percent,
        "direction": "up" if absolute > 0 else "down" if absolute < 0 else "flat",
    }


def _classify_pair(old_f: dict, new_f: dict) -> tuple[str, str, dict | None]:
    """(bucket, note, delta) for a biomarker present in BOTH reports."""
    name = new_f.get("parameter") or old_f.get("parameter") or "This value"
    unit = f" {new_f.get('unit')}" if new_f.get("unit") else ""
    old_abn, new_abn = _is_abnormal(old_f), _is_abnormal(new_f)
    old_v, new_v = old_f.get("numeric_value"), new_f.get("numeric_value")

    delta = None
    change = ""
    if old_v is not None and new_v is not None:
        delta = _delta(float(old_v), float(new_v))
        change = f" ({_fmt(old_v)} -> {_fmt(new_v)}{unit}"
        change += f", {'+' if delta['absolute'] > 0 else ''}{delta['percent']}%)" if delta["percent"] is not None else ")"

    if not old_abn and new_abn:
        status = (new_f.get("status") or "").upper()
        return ("new_abnormalities",
                f"{name} is now flagged {status}{change or ''} — it was within range in the earlier report.",
                delta)

    if old_abn and not new_abn:
        return ("resolved", f"{name} is back within the healthy range{change}.", delta)

    if old_abn and new_abn:
        if old_v is None or new_v is None:
            return ("unchanged", f"{name} is still flagged in both reports (no numeric values to compare).", delta)
        # Distance from the healthy band decides direction; the newer report's
        # own reference bounds are used for both sides so the yardstick is fixed.
        ref_low = new_f.get("ref_low") if new_f.get("ref_low") is not None else old_f.get("ref_low")
        ref_high = new_f.get("ref_high") if new_f.get("ref_high") is not None else old_f.get("ref_high")
        d_old = _distance_from_range(float(old_v), ref_low, ref_high)
        d_new = _distance_from_range(float(new_v), ref_low, ref_high)
        if delta["percent"] is not None and abs(delta["percent"]) < _EPSILON_PCT:
            return ("unchanged", f"{name} is still flagged, with little change{change}.", delta)
        if d_new < d_old:
            return ("improved", f"{name} moved closer to the healthy range{change} — still outside it.", delta)
        if d_new > d_old:
            return ("worsened", f"{name} moved farther from the healthy range{change}.", delta)
        return ("unchanged", f"{name} is still flagged, with little change{change}.", delta)

    # normal in both reports
    return ("unchanged", f"{name} stays within the healthy range{change}.", delta)


def _build_comparison(older: dict, newer: dict) -> dict:
    old_findings = {_norm(f.get("parameter")): f for f in (older["report"].get("findings") or []) if _norm(f.get("parameter"))}
    new_findings = {_norm(f.get("parameter")): f for f in (newer["report"].get("findings") or []) if _norm(f.get("parameter"))}

    buckets: dict[str, list[dict]] = {b: [] for b in BUCKETS}

    for key, new_f in new_findings.items():
        old_f = old_findings.get(key)
        name = new_f.get("parameter")
        if old_f is None:
            if _is_abnormal(new_f):
                status = (new_f.get("status") or "").upper()
                buckets["new_abnormalities"].append(_item(
                    new_f, None, new_f, None,
                    f"{name} is flagged {status} at {new_f.get('value')} — measured for the first time, so there is no earlier value to compare.",
                    first_measurement=True,
                ))
            else:
                buckets["newly_measured"].append(_item(
                    new_f, None, new_f, None,
                    f"{name} was measured for the first time and is within the healthy range.",
                    first_measurement=True,
                ))
            continue

        bucket, note, delta = _classify_pair(old_f, new_f)
        buckets[bucket].append(_item(new_f, old_f, new_f, delta, note))

    for key, old_f in old_findings.items():
        if key in new_findings:
            continue
        name = old_f.get("parameter")
        if _is_abnormal(old_f):
            note = (f"{name} was flagged {(old_f.get('status') or '').upper()} at {old_f.get('value')} "
                    "in the earlier report but was not measured this time — unresolved, worth re-checking.")
        else:
            note = f"{name} was normal in the earlier report and was not measured this time."
        buckets["not_remeasured"].append(_item(old_f, old_f, None, None, note))

    # Worst news first inside each bucket: larger relative change floats up.
    for items in buckets.values():
        items.sort(key=lambda i: -abs((i.get("delta") or {}).get("percent") or 0))

    counts = {b: len(items) for b, items in buckets.items()}
    meta_older = {k: older[k] for k in ("job_id", "date", "source_name")} | {"urgency": older["report"].get("urgency")}
    meta_newer = {k: newer[k] for k in ("job_id", "date", "source_name")} | {"urgency": newer["report"].get("urgency")}

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "older": meta_older,
        "newer": meta_newer,
        "buckets": buckets,
        "counts": counts,
        "summary": _fallback_summary(meta_older, counts, buckets),
        "summary_source": "deterministic",
        "disclaimer": newer["report"].get("disclaimer") or older["report"].get("disclaimer") or "",
    }


def _item(name_src: dict, old_f: dict | None, new_f: dict | None, delta: dict | None,
          note: str, first_measurement: bool = False) -> dict:
    item = {
        "parameter": name_src.get("parameter"),
        "unit": name_src.get("unit"),
        "older": _side(old_f),
        "newer": _side(new_f),
        "delta": delta,
        "note": note,
    }
    if first_measurement:
        item["first_measurement"] = True
    return item


def _fallback_summary(older_meta: dict, counts: dict, buckets: dict) -> str:
    """Deterministic summary from the computed counts — no LLM involved."""
    def names(bucket: str, n: int = 3) -> str:
        ns = [i["parameter"] for i in buckets[bucket][:n] if i.get("parameter")]
        return f" ({', '.join(ns)})" if ns else ""

    when = _short_date(older_meta.get("date"))
    parts = [f"Compared with the report{f' from {when}' if when else ''}:"]
    said = False
    for bucket, label in (
        ("new_abnormalities", "newly flagged value(s)"),
        ("resolved", "value(s) back in range"),
        ("improved", "flagged value(s) improved"),
        ("worsened", "flagged value(s) worsened"),
    ):
        if counts[bucket]:
            parts.append(f"{counts[bucket]} {label}{names(bucket)}.")
            said = True
    if counts["unchanged"]:
        parts.append(f"{counts['unchanged']} value(s) show little or no change.")
        said = True
    if counts["not_remeasured"]:
        parts.append(f"{counts['not_remeasured']} earlier value(s) were not re-measured this time{names('not_remeasured')}.")
        said = True
    if not said:
        parts.append("no overlapping values could be compared.")
    return " ".join(parts)


def _short_date(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%d %b %Y")
    except ValueError:
        return ""


# ── "WHAT CHANGED SINCE LAST REPORT" ──────────────────────
# A compact, chip-friendly view of the same deterministic diff. Used by the
# automatic strip at the top of a new report. Deliberately NO LLM here: it
# runs on every report open, so it must be instant and free — the wording is
# template-based and the full comparison view exists for a deeper look.

_CHANGE_LABELS = (
    ("new_abnormalities", "newly_abnormal"),
    ("worsened", "worsened"),
    ("improved", "improved"),
    ("resolved", "normalized"),
    ("unchanged", "unchanged"),
    ("newly_measured", "newly_measured"),
    ("not_remeasured", "not_remeasured"),
)


def build_change_records(older: dict, newer: dict) -> dict:
    """Flatten the deterministic diff into ordered change records.

    older/newer: same entry shape as generate_comparison. Returns
    {prior_date, prior_job_id, changes: [{parameter, change, direction,
    percent, note}], counts} with the most important changes first.
    """
    result = _build_comparison(older, newer)
    changes = []
    for bucket, label in _CHANGE_LABELS:
        for item in result["buckets"][bucket]:
            delta = item.get("delta") or {}
            changes.append({
                "parameter": item.get("parameter"),
                "change": label,
                "direction": delta.get("direction"),
                "percent": delta.get("percent"),
                "note": item.get("note"),
            })
    return {
        "prior_date": older.get("date"),
        "prior_job_id": older.get("job_id"),
        "changes": changes,
        "counts": {label: result["counts"][bucket] for bucket, label in _CHANGE_LABELS},
    }


# ── OPTIONAL LLM REWRITE ──────────────────────────────────
# Receives the finished buckets/counts and may ONLY rephrase them.

_SUMMARY_TOOL = {
    "type": "function",
    "function": {
        "name": "emit_comparison_summary",
        "description": "Return the rewritten plain-English comparison summary.",
        "parameters": {
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": "3-5 sentences, Grade 8 reading level.",
                }
            },
            "required": ["summary"],
        },
    },
}

_SUMMARY_SYSTEM = """
You rewrite a pre-computed comparison between two medical reports into a short
plain-English summary for the patient.

STRICT RULES:
- The comparison is ALREADY computed. Use only the classifications, values, and
  percentages provided. Do not recompute, reinterpret, or add anything.
- Never diagnose, never suggest treatments, never speculate about causes.
- Mention what is new, what resolved, what improved or worsened, and what was
  not re-measured — in that order of importance, skipping empty categories.
- 3-5 sentences, Grade 8 reading level, calm and encouraging where the data
  allows it.
- Return the summary ONLY by calling emit_comparison_summary.
""".strip()


async def _rewrite_summary(result: dict) -> str | None:
    """One LLM call to rephrase the computed comparison. Any failure → None."""
    from llm import chat_completion, llm_available
    if not llm_available():
        return None

    facts = {
        "older_report_date": _short_date(result["older"].get("date")),
        "newer_report_date": _short_date(result["newer"].get("date")),
        "counts": result["counts"],
        "details": {
            bucket: [i["note"] for i in items[:4]]
            for bucket, items in result["buckets"].items() if items
        },
    }

    try:
        response = await chat_completion(
            messages=[
                {"role": "system", "content": _SUMMARY_SYSTEM},
                {"role": "user", "content": "<computed_comparison>\n" + json.dumps(facts, indent=2)
                                            + "\n</computed_comparison>\n\nRewrite this as the patient-facing summary and call emit_comparison_summary."},
            ],
            max_tokens=400,
            temperature=0.2,
            tools=[_SUMMARY_TOOL],
            tool_choice={"type": "function", "function": {"name": "emit_comparison_summary"}},
        )
        for call in response.choices[0].message.tool_calls or []:
            if call.function.name == "emit_comparison_summary":
                summary = (json.loads(call.function.arguments).get("summary") or "").strip()
                if 40 <= len(summary) <= 1500:
                    return summary
    except Exception as exc:  # noqa: BLE001
        log.warning("Comparison summary rewrite failed (%s) — using deterministic summary", exc)
    return None
