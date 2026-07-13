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
from fpdf.enums import XPos, YPos

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


def _mc(pdf: FPDF, h: float, text: str) -> None:
    """multi_cell that returns the cursor to the left margin. fpdf2 >= 2.7
    defaults multi_cell to new_x=RIGHT, which leaves x at the right margin and
    makes the NEXT full-width multi_cell fail with 'not enough horizontal
    space' — so every multi_cell in this module goes through this wrapper."""
    pdf.multi_cell(0, h, _s(text), new_x=XPos.LMARGIN, new_y=YPos.NEXT)


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
        _mc(pdf, 6, line)
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
        _mc(pdf, 6, f"{i}. {q.get('question', '')}")
        _body(pdf, q.get("context", ""))

    # ── Citations ─────────────────────────────────────────
    citations = report.get("citations", [])
    if citations:
        _heading(pdf, "Clinical sources")
        for c in citations:
            pdf.set_font("Helvetica", "B", 9)
            pdf.set_text_color(*TEAL)
            _mc(pdf, 5, c.get("source", ""))
            _body(pdf, '"' + str(c.get("passage", "")) + '"', size=8)

    # ── Disclaimer ────────────────────────────────────────
    pdf.ln(4)
    pdf.set_font("Helvetica", "I", 8)
    pdf.set_text_color(*GREY)
    _mc(pdf, 4, report.get("disclaimer", ""))

    pdf.output(pdf_path)
    return pdf_path


def generate_packet_pdf(job_id: str, packet: dict) -> str:
    """Render a Doctor Visit Packet dict to a PDF and return its file path."""
    pdf_path = str(REPORTS_DIR / f"packet_{job_id[:8]}.pdf")

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    # ── Header ────────────────────────────────────────────
    pdf.set_font("Helvetica", "B", 20)
    pdf.set_text_color(*TEAL)
    pdf.cell(0, 10, "ClearChart - Doctor Visit Packet", ln=True)

    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(*GREY)
    meta = " | ".join(x for x in (
        packet.get("profile_name") or "",
        f"Report date: {_short_date(packet.get('report_date'))}" if packet.get("report_date") else "",
        URGENCY_LABEL.get(packet.get("urgency", ""), ""),
    ) if x)
    pdf.cell(0, 6, _s(meta), ln=True)
    pdf.ln(2)

    # ── Opening note ──────────────────────────────────────
    _heading(pdf, "Why I'm here")
    _body(pdf, packet.get("visit_note", ""))

    # ── Priority values ───────────────────────────────────
    _heading(pdf, "Values to discuss first")
    priority = packet.get("priority_findings") or []
    if not priority:
        _body(pdf, "No flagged values in this report.")
    for f in priority:
        pdf.set_font("Helvetica", "B", 11)
        pdf.set_text_color(*SLATE)
        line = f"{f.get('parameter', '')}: {f.get('value', '')} [{(f.get('status', '') or '').upper()}]"
        if f.get("reference_range"):
            line += f"  (healthy: {f['reference_range']})"
        _mc(pdf, 6, line)

    # ── Wellness scores ───────────────────────────────────
    wellness = packet.get("wellness") or []
    if wellness:
        _heading(pdf, "Wellness by body system (0-100, higher is healthier)")
        for d in wellness:
            _body(pdf, f"{d.get('area', '')}: {d.get('score', '')} ({d.get('status', '')})"
                       + (f" - {d['note']}" if d.get("note") else ""))

    # ── Timeline ──────────────────────────────────────────
    timeline = packet.get("timeline") or []
    if timeline:
        _heading(pdf, "How my values have moved")
        for line in timeline:
            _body(pdf, "- " + str(line))

    # ── Medications ───────────────────────────────────────
    _heading(pdf, "Current medications")
    meds = packet.get("medications") or []
    _body(pdf, ", ".join(meds) if meds else "None recorded in ClearChart.")

    # ── Questions ─────────────────────────────────────────
    _heading(pdf, "Questions to ask")
    for i, q in enumerate(packet.get("questions") or [], 1):
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_text_color(*SLATE)
        _mc(pdf, 6, f"[ ] {i}. {q.get('question', '')}")

    # ── Checklist ─────────────────────────────────────────
    _heading(pdf, "Follow-up checklist")
    for item in packet.get("checklist") or []:
        _body(pdf, "[ ] " + str(item))

    # ── Citations ─────────────────────────────────────────
    citations = packet.get("citations") or []
    if citations:
        _heading(pdf, "Clinical sources")
        for c in citations:
            pdf.set_font("Helvetica", "B", 9)
            pdf.set_text_color(*TEAL)
            _mc(pdf, 5, c.get("source", ""))
            _body(pdf, '"' + str(c.get("passage", "")) + '"', size=8)

    # ── Physician notes ───────────────────────────────────
    _heading(pdf, "Physician notes")
    pdf.set_draw_color(*GREY)
    for _ in range(6):
        pdf.ln(8)
        pdf.cell(0, 0, "", border="T", ln=True)

    # ── Disclaimer ────────────────────────────────────────
    pdf.ln(6)
    pdf.set_font("Helvetica", "I", 8)
    pdf.set_text_color(*GREY)
    _mc(pdf, 4, packet.get("disclaimer", ""))

    pdf.output(pdf_path)
    return pdf_path


def _short_date(iso: str | None) -> str:
    if not iso:
        return ""
    try:
        from datetime import datetime
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%d %b %Y")
    except ValueError:
        return iso


def _heading(pdf: FPDF, text: str) -> None:
    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 13)
    pdf.set_text_color(15, 23, 42)
    pdf.cell(0, 8, _s(text), ln=True)


def _body(pdf: FPDF, text: str, size: int = 10) -> None:
    pdf.set_font("Helvetica", "", size)
    pdf.set_text_color(*SLATE)
    _mc(pdf, 5, text)
