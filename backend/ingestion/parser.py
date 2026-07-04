"""
Document parser — Layer 1 of the ingestion pipeline.

Strategy (tried in order):
  1. pdfplumber   — fast, accurate for text-based PDFs
  2. pytesseract  — OCR fallback for scanned PDFs or images
  3. Raw bytes decode — last resort for plain text files

Why a fallback chain?
  Medical documents arrive in every format: printed lab sheets
  scanned to PDF, photographed on a phone, or copy-pasted from
  an EHR portal. A single parser misses too many real-world cases.
"""
from __future__ import annotations
import io
import re
import logging
from pathlib import Path

log = logging.getLogger(__name__)

# Optional imports — gracefully degrade if not installed
try:
    import pdfplumber
    _HAS_PDFPLUMBER = True
except ImportError:
    _HAS_PDFPLUMBER = False
    log.warning("pdfplumber not installed — PDF text extraction unavailable")

try:
    from PIL import Image
    import pytesseract
    _HAS_OCR = True
except ImportError:
    _HAS_OCR = False
    log.warning("Pillow/pytesseract not installed — OCR unavailable")


# ── PUBLIC API ────────────────────────────────────────────

def extract_text(content: bytes, filename: str = "upload") -> str:
    """
    Extract clean text from document bytes.
    Returns a single string with normalised whitespace.
    """
    ext = Path(filename).suffix.lower()

    if ext == ".pdf":
        text = _from_pdf(content)
    elif ext in {".jpg", ".jpeg", ".png", ".webp", ".tiff", ".bmp"}:
        text = _from_image(content)
    else:
        # Try PDF first (some files are misnamed), then raw decode
        text = _from_pdf(content) or content.decode("utf-8", errors="replace")

    return _clean(text)


# ── PRIVATE HELPERS ───────────────────────────────────────

def _from_pdf(content: bytes) -> str:
    """Extract text from a PDF using pdfplumber, with OCR fallback per page."""
    if not _HAS_PDFPLUMBER:
        return ""

    texts: list[str] = []
    try:
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text() or ""

                # If a page has very little text, it's probably a scanned image
                if len(page_text.strip()) < 30 and _HAS_OCR:
                    log.debug("Page %s appears scanned — attempting OCR", page.page_number)
                    img = page.to_image(resolution=200).original
                    page_text = pytesseract.image_to_string(img, config="--psm 6")

                texts.append(page_text)
    except Exception as exc:
        log.error("pdfplumber failed: %s", exc)
        return ""

    return "\n\n".join(texts)


def _from_image(content: bytes) -> str:
    """OCR an image file directly."""
    if not _HAS_OCR:
        raise RuntimeError("pytesseract is required for image files. Install it with: pip install pytesseract Pillow")

    try:
        img = Image.open(io.BytesIO(content))
        # Tesseract config: --psm 6 assumes a uniform block of text (good for lab reports)
        text = pytesseract.image_to_string(img, config="--psm 6")
        return text
    except Exception as exc:
        log.error("OCR failed: %s", exc)
        raise RuntimeError(f"Image OCR failed: {exc}") from exc


def _clean(text: str) -> str:
    """
    Normalise extracted text:
    - Strip control characters except newlines/tabs
    - Collapse 3+ blank lines into 2
    - Strip leading/trailing whitespace
    """
    # Remove non-printable characters except \n and \t
    text = re.sub(r"[^\x09\x0A\x20-\x7E -￿]", " ", text)
    # Collapse multiple blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    # Collapse multiple spaces
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()
