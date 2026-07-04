"""
PDF report generator.

Converts a completed AnalysisReport dict into a clean, shareable PDF.

We use fpdf2 (pure Python) instead of WeasyPrint: WeasyPrint needs native
Cairo/Pango/GDK libraries that bloat the Docker image and frequently break the
build. fpdf2 is `pip install` and done — important for a "runs anywhere" deploy.
"""
from __future__ import annotations
import logging
import tempfile
from pathlib import Path

from fpdf import FPDF

log = logging.getLogger(__name__)

REPORTS_DIR = Path(tempfile.gettempdir()) / "clearchart_reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

TEAL = (13, 148, 136)
SLATE = (51, 65, 85)
GREY = (148, 163, 184)

URGENCY_LABEL = {
    "urgent": "Needs Attention",
    "watch": "Worth Discussing",
    "routine": "Routine",
}
URGENCY_COLOR = {
    "urgent": (239, 68, 68),
    "watch": (245, 158, 11),
    "routine": (16, 185, 129),
}

# Map a few common unicode glyphs to latin-1 so the core PDF fonts can render
# them. (Core fonts are latin-1 only; this keeps the fallback dependency-free.)
_GLYPHS = {"–": "-", "—": "-", "↑": "(high)", "↓": "(low)",
           "µ": "u", "²": "2", "≥": ">=", "≤": "<=",
           "•": "-", "‘": "'", "’": "'", "“": '"', "”": '"'}


def _s(text) -> str:
    """Sanitise a string to latin-1 (core-font safe)."""
    s = str(text or "")
    for u, a in _GLYPHS.items():
        s = s.replace(u, a)
    return s.encode("latin-1", "replace").decode("latin-1")


def generate_pdf(job_id: str, report: dict) -> str:
    """Render an AnalysisReport dict to a PDF and return its file path."""
    pdf_path = str(REPORTS_DIR / f"report_{job_id[:8]}.pdf")

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    # ── Header ────────────────────────────────────────────
    pdf.set_font("Helvetica", "B", 20)
    pdf.set_text_color(*TEAL)
    pdf.cell(0, 10, "ClearChart", ln=True)

    urgency = report.get("urgency", "routine")
    pdf.set_font("Helvetica", "B", 11)
    pdf.set_text_color(*URGENCY_COLOR.get(urgency, GREY))
    pdf.cell(0, 8, _s(URGENCY_LABEL.get(urgency, urgency.title())), ln=True)
    pdf.ln(2)

    # ── Summary ───────────────────────────────────────────
    _heading(pdf, "Summary")
    _body(pdf, report.get("summary", ""))
    if report.get("patient_context"):
        _body(pdf, "Document context: " + report["patient_context"])

    # ── Findings ──────────────────────────────────────────
    findings = report.get("findings", [])
    _heading(pdf, f"Findings ({len(findings)})")
    if not findings:
        _body(pdf, "No specific values detected.")
    for f in findings:
        pdf.set_font("Helvetica", "B", 11)
        pdf.set_text_color(*SLATE)
        line = f"{f.get('parameter', '')}: {f.get('value', '')} [{(f.get('status', '') or '').upper()}]"
        if f.get("reference_range"):
            line += f"  (ref: {f['reference_range']})"
        pdf.multi_cell(0, 6, _s(line))
        _body(pdf, f.get("explanation", ""))
        pdf.ln(1)

    # ── Questions ─────────────────────────────────────────
    _heading(pdf, "Questions to ask your doctor")
    questions = report.get("questions_for_doctor", [])
    if not questions:
        _body(pdf, "Ask your doctor to walk through each result with you.")
    for i, q in enumerate(questions, 1):
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_text_color(*SLATE)
        pdf.multi_cell(0, 6, _s(f"{i}. {q.get('question', '')}"))
        _body(pdf, q.get("context", ""))

    # ── Citations ─────────────────────────────────────────
    citations = report.get("citations", [])
    if citations:
        _heading(pdf, "Clinical sources")
        for c in citations:
            pdf.set_font("Helvetica", "B", 9)
            pdf.set_text_color(*TEAL)
            pdf.multi_cell(0, 5, _s(c.get("source", "")))
            _body(pdf, '"' + str(c.get("passage", "")) + '"', size=8)

    # ── Disclaimer ────────────────────────────────────────
    pdf.ln(4)
    pdf.set_font("Helvetica", "I", 8)
    pdf.set_text_color(*GREY)
    pdf.multi_cell(0, 4, _s(report.get("disclaimer", "")))

    pdf.output(pdf_path)
    return pdf_path


def _heading(pdf: FPDF, text: str) -> None:
    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 13)
    pdf.set_text_color(15, 23, 42)
    pdf.cell(0, 8, _s(text), ln=True)


def _body(pdf: FPDF, text: str, size: int = 10) -> None:
    pdf.set_font("Helvetica", "", size)
    pdf.set_text_color(*SLATE)
    pdf.multi_cell(0, 5, _s(text))
