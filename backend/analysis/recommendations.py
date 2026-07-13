"""
Follow-up recommendation generator — deterministic, guideline-backed.

Each recommendation comes from a fixed rule table keyed on the parameter
name and abnormal direction of findings the rule engine ALREADY validated.
If no rule matches a flagged value, no recommendation is produced for it —
nothing is ever invented. The LLM's only optional role is rephrasing the
generated `reason` strings into friendlier wording (strictly validated:
same count, or the deterministic text is kept).

Citations: each rule tries to reuse a citation already retrieved for the
report (keyword match against the report's own citations); failing that it
falls back to the rule's static guideline reference. Both are deterministic.
"""
from __future__ import annotations

import json
import logging
import re

log = logging.getLogger("clearchart.recommendations")

# Priority from the rule engine's severity — never decided by the LLM.
_PRIORITY = {"critical": "high", "moderate": "medium", "mild": "low"}

# when: "high" | "low" | "abnormal" (any non-normal status)
_RULES = [
    {
        "match": re.compile(r"hba1c|a1c|glucose|blood sugar", re.I), "when": "high",
        "action": "Repeat HbA1c (or fasting glucose) in about 3 months",
        "keywords": ("a1c", "glucose", "diabet"),
        "citation": {"source": "ADA Standards of Care — Glycemic Testing",
                     "url": "https://diabetesjournals.org/care/issue/47/Supplement_1"},
    },
    {
        "match": re.compile(r"\bldl\b|total cholesterol|non-?hdl", re.I), "when": "high",
        "action": "Discuss elevated LDL and overall heart risk with a physician",
        "keywords": ("ldl", "cholesterol", "statin", "lipid"),
        "citation": {"source": "USPSTF — Statin Use for Primary Prevention of CVD",
                     "url": "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/statin-use-in-adults-preventive-medication"},
    },
    {
        "match": re.compile(r"triglyceride", re.I), "when": "high",
        "action": "Ask about a repeat fasting lipid panel and triglyceride targets",
        "keywords": ("triglyceride", "lipid"),
        "citation": {"source": "NIH MedlinePlus — Triglycerides",
                     "url": "https://medlineplus.gov/triglycerides.html"},
    },
    {
        "match": re.compile(r"\bhdl\b", re.I), "when": "low",
        "action": "Ask which lifestyle changes best raise HDL (exercise, smoking cessation)",
        "keywords": ("hdl", "lipid", "cholesterol"),
        "citation": {"source": "NIH MedlinePlus — HDL: The 'Good' Cholesterol",
                     "url": "https://medlineplus.gov/hdlthegoodcholesterol.html"},
    },
    {
        "match": re.compile(r"creatinine|\begfr\b|\bbun\b|urea", re.I), "when": "abnormal",
        "action": "Ask about kidney function changes and whether a repeat test or urine check is needed",
        "keywords": ("kidney", "creatinine", "egfr", "gfr"),
        "citation": {"source": "KDIGO — CKD Evaluation and Management",
                     "url": "https://kdigo.org/guidelines/ckd-evaluation-and-management/"},
    },
    {
        "match": re.compile(r"h(a?)emoglobin(?!\s*a1c)|\bhgb\b|hematocrit|\brbc\b", re.I), "when": "low",
        "action": "Ask about iron studies (ferritin) and B12/folate to find the cause of low blood counts",
        "keywords": ("hemoglobin", "anemia", "iron", "ferritin"),
        "citation": {"source": "NIH MedlinePlus — Anemia",
                     "url": "https://medlineplus.gov/anemia.html"},
    },
    {
        "match": re.compile(r"vitamin\s*d|25-?oh", re.I), "when": "low",
        "action": "Ask about vitamin D supplementation and when to re-test (often ~3 months)",
        "keywords": ("vitamin d",),
        "citation": {"source": "NIH ODS — Vitamin D Fact Sheet",
                     "url": "https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/"},
    },
    {
        "match": re.compile(r"vitamin\s*b\s*12|cobalamin", re.I), "when": "low",
        "action": "Ask about B12 supplementation and checking for absorption problems",
        "keywords": ("b12",),
        "citation": {"source": "NIH ODS — Vitamin B12 Fact Sheet",
                     "url": "https://ods.od.nih.gov/factsheets/VitaminB12-HealthProfessional/"},
    },
    {
        "match": re.compile(r"\btsh\b|thyroid", re.I), "when": "abnormal",
        "action": "Ask about repeating TSH together with free T4 to confirm thyroid status",
        "keywords": ("tsh", "thyroid"),
        "citation": {"source": "NIH MedlinePlus — TSH Test",
                     "url": "https://medlineplus.gov/lab-tests/tsh-thyroid-stimulating-hormone-test/"},
    },
    {
        "match": re.compile(r"\balt\b|\bast\b|alanine|aspartate|bilirubin|alkaline phosphatase", re.I), "when": "high",
        "action": "Ask about repeating liver enzymes in 4–8 weeks and reviewing alcohol/medication factors",
        "keywords": ("liver", "alt", "ast", "hepat"),
        "citation": {"source": "NIH MedlinePlus — Liver Function Tests",
                     "url": "https://medlineplus.gov/lab-tests/liver-function-tests/"},
    },
    {
        "match": re.compile(r"potassium|sodium", re.I), "when": "abnormal",
        "action": "Ask about re-checking this electrolyte promptly and reviewing medications that affect it",
        "keywords": ("potassium", "sodium", "electrolyte"),
        "citation": {"source": "NIH MedlinePlus — Electrolyte Panel",
                     "url": "https://medlineplus.gov/lab-tests/electrolyte-panel/"},
    },
    {
        "match": re.compile(r"blood pressure|systolic|diastolic|hypertension", re.I), "when": "high",
        "action": "Track home blood pressure readings for 1–2 weeks and bring them to the appointment",
        "keywords": ("blood pressure", "hypertension"),
        "citation": {"source": "AHA — Home Blood Pressure Monitoring",
                     "url": "https://www.heart.org/en/health-topics/high-blood-pressure"},
    },
    {
        "match": re.compile(r"uric acid|urate", re.I), "when": "high",
        "action": "Ask about hydration, diet factors, and whether a repeat uric acid test is needed",
        "keywords": ("uric",),
        "citation": {"source": "NIH MedlinePlus — Uric Acid Test",
                     "url": "https://medlineplus.gov/lab-tests/uric-acid-test/"},
    },
]


def _direction_matches(rule_when: str, status: str) -> bool:
    status = (status or "").lower()
    if status == "normal":
        return False
    if rule_when == "abnormal":
        return True
    return status == rule_when or (rule_when == "high" and status == "abnormal")


def _match_report_citation(keywords: tuple, citations: list[dict]) -> dict | None:
    """Prefer a citation the report already retrieved for this topic."""
    for c in citations or []:
        text = f"{c.get('source', '')} {c.get('passage', '')}".lower()
        if any(k in text for k in keywords):
            return {"source": c.get("source"), "url": c.get("url")}
    return None


def generate_recommendations(report: dict) -> list[dict]:
    """Deterministic follow-up recommendations from a completed report.

    Returns [{parameter, action, reason, priority, citation}] — no DB fields;
    the caller persists them. Rules that don't match produce nothing.
    """
    findings = report.get("findings") or []
    citations = report.get("citations") or []
    recs: list[dict] = []
    seen_actions: set[str] = set()

    for f in findings:
        status = (f.get("status") or "").lower()
        if status == "normal":
            continue
        param = f.get("parameter") or ""
        for rule in _RULES:
            if not rule["match"].search(param) or not _direction_matches(rule["when"], status):
                continue
            if rule["action"] in seen_actions:
                break
            seen_actions.add(rule["action"])
            ref = f.get("reference_range")
            reason = f"{param} is {f.get('value')}" + (f" — outside the healthy range ({ref})." if ref else " — outside the healthy range.")
            recs.append({
                "parameter": param,
                "action": rule["action"],
                "reason": reason,
                "priority": _PRIORITY.get((f.get("severity") or "").lower(), "medium"),
                "citation": _match_report_citation(rule["keywords"], citations) or rule["citation"],
            })
            break  # first matching rule wins for a finding

    # One generic, always-safe item so the tracker is useful even for clean reports.
    recs.append({
        "parameter": None,
        "action": "Bring this report and your current medication list to your next appointment",
        "reason": "Having the exact values and medications on hand makes the visit faster and safer.",
        "priority": "low",
        "citation": None,
    })

    order = {"high": 0, "medium": 1, "low": 2}
    recs.sort(key=lambda r: order.get(r["priority"], 3))
    return recs


# ── OPTIONAL LLM POLISH ───────────────────────────────────
# May ONLY rephrase the generated reasons. Strictly validated: the model must
# return exactly one text per recommendation or everything stays deterministic.

_POLISH_TOOL = {
    "type": "function",
    "function": {
        "name": "emit_reasons",
        "description": "Return the rewritten reasons, one per recommendation, same order.",
        "parameters": {
            "type": "object",
            "properties": {
                "reasons": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["reasons"],
        },
    },
}

_POLISH_SYSTEM = """
You rewrite short medical follow-up reasons into friendlier plain English.

STRICT RULES:
- One rewritten reason per input, SAME ORDER, same count.
- Keep every number, value, and range EXACTLY as given. Add nothing new.
- No diagnosis, no treatment advice, one sentence each, Grade 8 level.
- Return ONLY by calling emit_reasons.
""".strip()


async def polish_reasons(recs: list[dict]) -> bool:
    """Rewrite reasons in place. Returns True if the LLM version was used."""
    from llm import chat_completion, llm_available
    if not llm_available() or not recs:
        return False
    try:
        response = await chat_completion(
            messages=[
                {"role": "system", "content": _POLISH_SYSTEM},
                {"role": "user", "content": json.dumps([r["reason"] for r in recs], indent=2)},
            ],
            max_tokens=600,
            temperature=0.2,
            tools=[_POLISH_TOOL],
            tool_choice={"type": "function", "function": {"name": "emit_reasons"}},
        )
        for call in response.choices[0].message.tool_calls or []:
            if call.function.name == "emit_reasons":
                texts = json.loads(call.function.arguments).get("reasons") or []
                if len(texts) == len(recs) and all(isinstance(t, str) and 10 <= len(t) <= 300 for t in texts):
                    for r, t in zip(recs, texts):
                        r["reason"] = t.strip()
                    return True
                log.warning("Reason polish rejected: wrong shape (%d texts for %d recs)", len(texts), len(recs))
    except Exception as exc:  # noqa: BLE001
        log.warning("Reason polish failed (%s) — keeping deterministic reasons", exc)
    return False
