"""
LLM Synthesizer — the AI brain of ClearChart (Groq).

Receives:
  - raw_text       : the full extracted document
  - rule_anomalies : structured Findings from the deterministic rule engine

Produces:
  - AnalysisReport : a fully-validated, structured Pydantic object

KEY DESIGN DECISIONS

1. STRUCTURED OUTPUT VIA FUNCTION CALLING
   We declare one tool/function whose parameters ARE the report shape, then force
   the model to call it (`tool_choice` = that function). The model returns its
   answer as the function arguments — structured JSON in our schema, no brittle
   free-text parsing. Groq exposes an OpenAI-compatible function-calling API.

2. RULE FINDINGS ARE GROUND TRUTH
   The verified numeric findings are injected as <verified_findings>. The model is
   told never to contradict them. LLMs are unreliable at arithmetic/boundary
   checks, so numbers come from the rule engine; the model only does language.

3. RAG CONTEXT IN PROMPT
   Retrieved clinical-guideline passages are injected as <clinical_context>.
   Every doctor-question and citation must trace back to one of them.

4. SAFETY FRAMING
   The system prompt hard-codes this as a health-literacy tool: never diagnose,
   never recommend treatment, always include the disclaimer.

5. GRACEFUL FALLBACK
   No API key / API error → a deterministic rule-only report. The product never
   hard-fails just because the LLM is unavailable.
"""
from __future__ import annotations
import json
import logging

from config import settings
from llm import chat_completion, llm_available
from api.schemas import (
    AnalysisReport, UrgencyLevel, Finding, FindingStatus, Severity,
    DoctorQuestion, Citation, HealthDomain,
)

log = logging.getLogger(__name__)

MAX_CONTEXT_CHARS = 12_000  # stay well within the context window


# ── STRUCTURED-OUTPUT FUNCTION DEFINITION ─────────────────
# Parameters mirror AnalysisReport. Forcing this function guarantees the model
# returns data in exactly this shape (OpenAI/Groq function-calling format).
_REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "urgency": {
            "type": "string",
            "enum": ["urgent", "watch", "routine"],
            "description": "Overall urgency. Defer to the verified findings' severity.",
        },
        "summary": {
            "type": "string",
            "description": "A descriptive, plain-English (Grade 8) explanation of the "
                           "results, roughly 150-250 words, written in an encouraging tone.",
        },
        "patient_context": {"type": "string", "description": "What kind of document this is and what was detected."},
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "parameter": {"type": "string"},
                    "value": {"type": "string"},
                    "reference_range": {"type": "string"},
                    "status": {"type": "string", "enum": ["high", "low", "abnormal", "normal"]},
                    "severity": {"type": "string", "enum": ["critical", "moderate", "mild", "normal"]},
                    "explanation": {"type": "string"},
                },
                "required": ["parameter", "value", "status", "severity", "explanation"],
            },
        },
        "questions_for_doctor": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "context": {"type": "string"},
                    "citation": {"type": "string"},
                },
                "required": ["question", "context"],
            },
        },
        "citations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "source": {"type": "string"},
                    "passage": {"type": "string"},
                    "url": {"type": "string"},
                },
                "required": ["source", "passage"],
            },
        },
        "health_snapshot": {
            "type": "array",
            "description": "Visual analysis: score each relevant body system 0-100 (100 = fully healthy) "
                           "so the app can render a chart. Include 3-6 systems tied to the findings.",
            "items": {
                "type": "object",
                "properties": {
                    "area": {"type": "string", "description": "Body system, e.g. 'Blood Sugar', 'Cholesterol / Heart', 'Thyroid', 'Body Weight'"},
                    "score": {"type": "integer", "minimum": 0, "maximum": 100},
                    "status": {"type": "string", "enum": ["good", "watch", "concern"]},
                    "note": {"type": "string", "description": "One short plain-language line"},
                },
                "required": ["area", "score", "status"],
            },
        },
        "confidence_score": {"type": "number", "minimum": 0.0, "maximum": 1.0},
        "disclaimer": {"type": "string"},
    },
    "required": ["urgency", "summary", "findings", "questions_for_doctor", "citations", "health_snapshot", "confidence_score", "disclaimer"],
}

REPORT_TOOL = {
    "type": "function",
    "function": {
        "name": "emit_report",
        "description": "Return the structured health-literacy analysis of the patient's document.",
        "parameters": _REPORT_SCHEMA,
    },
}


# ── PUBLIC API ────────────────────────────────────────────

async def synthesize_report(
    raw_text: str,
    rule_anomalies: list[Finding],
) -> AnalysisReport:
    """RAG retrieval + Groq synthesis → AnalysisReport (rule-only fallback)."""
    guideline_passages = await _retrieve_guidelines(raw_text[:2000])

    if not llm_available():
        log.warning("No LLM provider configured — returning rule-only report")
        return _rule_only_report(rule_anomalies, guideline_passages)

    system_prompt = _build_system_prompt()
    user_prompt = _build_user_prompt(raw_text, rule_anomalies, guideline_passages)

    try:
        # chat_completion walks the provider chain (Groq → OpenRouter → …),
        # so a rate-limited primary falls back transparently.
        response = await chat_completion(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=settings.llm_max_tokens,
            temperature=settings.llm_temperature,
            tools=[REPORT_TOOL],
            tool_choice={"type": "function", "function": {"name": "emit_report"}},
        )

        data = _extract_tool_args(response)
        if data is None:
            raise ValueError("The model did not return the emit_report function call.")

        return _parse_llm_response(data, rule_anomalies, guideline_passages)

    except Exception as exc:  # noqa: BLE001
        log.error("LLM synthesis failed (%s) — using rule-only report", exc)
        return _rule_only_report(rule_anomalies, guideline_passages)


def _extract_tool_args(response) -> dict | None:
    """Pull the forced function call's JSON arguments out of the response."""
    try:
        tool_calls = response.choices[0].message.tool_calls or []
        for call in tool_calls:
            if call.function.name == "emit_report":
                return json.loads(call.function.arguments)
    except (AttributeError, IndexError, json.JSONDecodeError) as exc:
        log.warning("Could not parse the model's tool call: %s", exc)
    return None


# ── PROMPT BUILDERS ───────────────────────────────────────

def _build_system_prompt() -> str:
    return """
You are ClearChart, an AI health-literacy assistant.
Your ONLY job is to help patients understand their own medical records.

STRICT RULES:
- You do NOT diagnose conditions.
- You do NOT recommend specific medications or treatments.
- The urgency level is guided by the rule engine's verified findings — do not inflate it.
- Every claim in your summary must trace back to <verified_findings> or <clinical_context>.
- Write at a Grade 8 reading level. When a medical term is unavoidable, explain it in parentheses.
- The summary must be DESCRIPTIVE and thorough (roughly 150-250 words, a few short
  paragraphs) — not a single terse sentence. Walk the patient through what the
  results mean overall, group related findings, and end on a calm, actionable note.
- Populate health_snapshot with 3-6 body systems relevant to the findings, each
  scored 0-100 (100 = fully healthy). This is a VISUAL analysis the app renders as
  a chart, so make the scores reflect the verified findings' severity.
- Always populate the disclaimer field.
- Return your answer ONLY by calling the emit_report function.
""".strip()


def _build_user_prompt(
    raw_text: str,
    rule_anomalies: list[Finding],
    guideline_passages: list[dict],
) -> str:
    doc_excerpt = raw_text[:MAX_CONTEXT_CHARS]
    findings_json = json.dumps([f.model_dump(mode="json") for f in rule_anomalies], indent=2)
    context_text = "\n\n".join(
        f"SOURCE: {p['source']}\nURL: {p.get('url', 'N/A')}\nPASSAGE: {p['passage']}"
        for p in guideline_passages[:8]
    ) or "No specific guideline passages retrieved."

    return f"""
<document>
{doc_excerpt}
</document>

<verified_findings>
These values were extracted and verified by a deterministic rule engine.
Do NOT contradict or change these numeric values. Use them as the factual
backbone of your summary.
{findings_json}
</verified_findings>

<clinical_context>
Authoritative clinical-guideline passages relevant to the findings above.
Ground your questions_for_doctor and citations in these passages.
{context_text}
</clinical_context>

Analyze the document and call emit_report. Write a descriptive summary that genuinely
helps a non-medical patient understand their results and prepare for their next
doctor's appointment.
""".strip()


# ── RESPONSE PARSER ───────────────────────────────────────

def _parse_llm_response(
    data: dict,
    rule_anomalies: list[Finding],
    guideline_passages: list[dict],
) -> AnalysisReport:
    """Validate the model's structured output, backfilling from rule data."""
    # Always use the rule-engine findings as the canonical list: they carry the
    # validated numeric values + reference bounds the UI comparison charts need.
    # The LLM's job is the narrative (summary, questions, context), not the numbers.
    findings = rule_anomalies

    questions = [
        DoctorQuestion(
            question=q.get("question", ""),
            context=q.get("context", ""),
            citation=q.get("citation"),
        )
        for q in (data.get("questions_for_doctor") or [])
    ]

    citations = [
        Citation(source=c.get("source", ""), passage=c.get("passage", ""), url=c.get("url"))
        for c in (data.get("citations") or [])
    ]
    if not citations and guideline_passages:
        citations = [
            Citation(source=p["source"], passage=p["passage"], url=p.get("url"))
            for p in guideline_passages[:4]
        ]

    # Prefer the model's visual snapshot; fall back to a deterministic one so the
    # chart always renders with data tied to the actual findings.
    snapshot = _parse_snapshot(data.get("health_snapshot")) or _snapshot_from_findings(findings)

    try:
        urgency = UrgencyLevel(data.get("urgency", "routine"))
    except ValueError:
        urgency = _infer_urgency(findings)

    return AnalysisReport(
        urgency=urgency,
        summary=data.get("summary", "Analysis complete. See findings below."),
        patient_context=data.get("patient_context"),
        findings=findings,
        questions_for_doctor=questions,
        citations=citations,
        health_snapshot=snapshot,
        confidence_score=float(data.get("confidence_score", 0.7)),
        disclaimer=data.get("disclaimer") or _DISCLAIMER,
    )


def _parse_snapshot(raw) -> list[HealthDomain]:
    """Validate the model's health_snapshot array into HealthDomain objects."""
    out: list[HealthDomain] = []
    for d in (raw or []):
        try:
            score = int(round(float(d.get("score", 50))))
        except (TypeError, ValueError):
            score = 50
        status = d.get("status") or ("good" if score >= 80 else "watch" if score >= 55 else "concern")
        area = (d.get("area") or "").strip()
        if area:
            out.append(HealthDomain(area=area, score=max(0, min(100, score)), status=status, note=d.get("note")))
    return out


# Map each lab parameter to a body-system label for the deterministic snapshot.
_SYSTEM_MAP = {
    "Fasting Glucose": "Blood Sugar", "Hemoglobin A1c": "Blood Sugar",
    "LDL Cholesterol": "Cholesterol / Heart", "HDL Cholesterol": "Cholesterol / Heart",
    "Total Cholesterol": "Cholesterol / Heart", "Triglycerides": "Cholesterol / Heart",
    "ALT (Liver)": "Liver", "AST (Liver)": "Liver", "Alkaline Phosphatase": "Liver", "Total Bilirubin": "Liver",
    "Creatinine": "Kidney", "eGFR": "Kidney", "BUN (Urea Nitrogen)": "Kidney",
    "TSH (Thyroid)": "Thyroid", "Free T4": "Thyroid",
    "BMI (Body Mass Index)": "Body Weight",
    "Hemoglobin": "Blood Count", "Hematocrit": "Blood Count", "WBC (White Blood Cells)": "Blood Count",
    "Platelets": "Blood Count", "RBC (Red Blood Cells)": "Blood Count",
}
_SEVERITY_SCORE = {Severity.NORMAL: 100, Severity.MILD: 70, Severity.MODERATE: 45, Severity.CRITICAL: 20}


def _snapshot_from_findings(findings: list[Finding]) -> list[HealthDomain]:
    """Deterministic fallback: average finding severity into per-system scores."""
    buckets: dict[str, list[int]] = {}
    for f in findings:
        area = _SYSTEM_MAP.get(f.parameter, "Other Labs")
        buckets.setdefault(area, []).append(_SEVERITY_SCORE.get(f.severity, 60))

    snapshot: list[HealthDomain] = []
    for area, scores in buckets.items():
        avg = int(round(sum(scores) / len(scores)))
        status = "good" if avg >= 80 else "watch" if avg >= 55 else "concern"
        snapshot.append(HealthDomain(area=area, score=avg, status=status))
    snapshot.sort(key=lambda d: d.score)   # worst first — draws the eye
    return snapshot


# ── FALLBACK: RULE-ONLY REPORT ────────────────────────────

def _rule_only_report(
    rule_anomalies: list[Finding],
    guideline_passages: list[dict] | None = None,
) -> AnalysisReport:
    """Deterministic report from rule findings only (no LLM available)."""
    abnormal = [f for f in rule_anomalies if f.status != FindingStatus.NORMAL]
    urgency = _infer_urgency(rule_anomalies)

    if not abnormal:
        summary = (
            "All detected lab values appear to be within normal reference ranges. "
            "No immediate concerns were identified from the extracted values."
        )
    else:
        names = ", ".join(f.parameter for f in abnormal[:3])
        summary = (
            f"Analysis detected {len(abnormal)} value(s) outside normal reference ranges: {names}. "
            "Please review the Findings below and bring these results to your next doctor's appointment."
        )

    citations = []
    if guideline_passages:
        citations = [
            Citation(source=p["source"], passage=p["passage"], url=p.get("url"))
            for p in guideline_passages[:3]
        ]

    return AnalysisReport(
        urgency=urgency,
        summary=summary,
        patient_context=f"{len(rule_anomalies)} lab values detected and checked against standard reference ranges.",
        findings=rule_anomalies,
        questions_for_doctor=[
            DoctorQuestion(
                question="Can you walk me through each of my results and what they mean for my health?",
                context="A clear explanation of all values from your doctor ensures nothing is missed.",
            )
        ],
        citations=citations,
        health_snapshot=_snapshot_from_findings(rule_anomalies),
        confidence_score=0.5,
        disclaimer=_DISCLAIMER,
    )


# ── HELPERS ───────────────────────────────────────────────

def _infer_urgency(findings: list[Finding]) -> UrgencyLevel:
    severities = {f.severity for f in findings}
    if Severity.CRITICAL in severities:
        return UrgencyLevel.URGENT
    if Severity.MODERATE in severities or Severity.MILD in severities:
        return UrgencyLevel.WATCH
    return UrgencyLevel.ROUTINE


async def _retrieve_guidelines(query: str) -> list[dict]:
    """Retrieve relevant clinical-guideline passages (FAISS + BM25 hybrid)."""
    try:
        from rag.retriever import retrieve
        return await retrieve(query)
    except Exception as exc:  # noqa: BLE001
        log.warning("Guideline retrieval failed: %s", exc)
        return []


_DISCLAIMER = (
    "This report is for health literacy purposes only. It is not a medical "
    "diagnosis, clinical opinion, or professional advice. Always consult a "
    "qualified, licensed healthcare professional before making any decisions "
    "about your health."
)
